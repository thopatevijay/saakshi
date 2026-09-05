"""Vehicle re-ID: the embedder, the colour-constancy correction, and the spatio-temporal gate.

Every positive assertion here has a negative control, per the house rule from `test_motion.py`: a
gate that rejects everything would pass a "the ungated match is rejected" test on its own.
"""

from __future__ import annotations

import json
import math
import pathlib

import cv2
import numpy as np
import pytest

from ..reid import (
    EMBEDDING_DIM,
    REID_DEFAULTS,
    SIGMA_FAST,
    SIGMA_SLOW,
    ColourConstantEmbedder,
    GalleryEntry,
    ReidThresholds,
    best_match,
    cosine,
    create_embedder,
    embedder_name,
    gate_reason,
    link_confidence,
    passes_spatiotemporal_gate,
    shades_of_grey,
    timing_plausibility,
)
from ..reid_dataset import FIXTURES, load_pairs

FIXTURE_ROOT = pathlib.Path(FIXTURES)


def car(colour: tuple[int, int, int], size: int = 96, seed: int = 0) -> np.ndarray:
    """A synthetic vehicle crop that states its own ground truth: a coloured body, a darker glass
    band across the top third, and reproducible noise so two calls are not bit-identical by luck."""
    rng = np.random.default_rng(seed)
    image = np.zeros((size, size, 3), dtype=np.uint8)
    image[:, :] = colour
    image[: size // 3, :] = tuple(int(c * 0.35) for c in colour)
    noise = rng.normal(0.0, 4.0, image.shape)
    return np.clip(image.astype(np.float64) + noise, 0, 255).astype(np.uint8)


def under_light(image: np.ndarray, gains: tuple[float, float, float]) -> np.ndarray:
    """The same vehicle seen by a camera with a different white balance."""
    tinted = image.astype(np.float64) * np.array(gains, dtype=np.float64)
    return np.clip(tinted, 0, 255).astype(np.uint8)


# ── the embedder ────────────────────────────────────────────────────────────────────────────────


def test_reid_embedding_is_unit_length_and_the_declared_width() -> None:
    vector = ColourConstantEmbedder().embed(car((40, 40, 200)))
    assert vector.shape == (EMBEDDING_DIM,), "the stored column width must match the descriptor"
    assert vector.dtype == np.float32, "float32 keeps the Postgres real[] round trip lossless"
    assert math.isclose(float(np.linalg.norm(vector)), 1.0, rel_tol=1e-5), (
        "cosine similarity assumes unit vectors; an unnormalised one makes every score meaningless"
    )


def test_reid_embedding_is_deterministic() -> None:
    crop = car((200, 200, 200), seed=7)
    a = ColourConstantEmbedder().embed(crop)
    b = ColourConstantEmbedder().embed(crop)
    assert np.array_equal(a, b), "a descriptor that moves between runs cannot be stored and reused"


def test_reid_embedding_ranks_a_different_colour_below_the_same_colour() -> None:
    embedder = ColourConstantEmbedder()
    red = embedder.embed(car((40, 40, 200), seed=1))
    red_again = embedder.embed(car((40, 40, 200), seed=9))
    blue = embedder.embed(car((200, 60, 40), seed=1))
    assert cosine(red, blue) < cosine(red, red_again), (
        "the same vehicle under noise must score above a different-coloured one"
    )


def test_reid_embedding_dilutes_its_own_colour_evidence() -> None:
    """A named limitation, asserted so nobody discovers it by surprise in the field.

    Cosine over sqrt-normalised histogram blocks is a *weighted mean of per-block Bhattacharyya
    coefficients*. On a flat synthetic crop the saturation, value and shape blocks are identical
    between two vehicles, so eleven of twelve blocks score 1.0 and only hue disagrees — a red car and
    a blue car land at ~0.97, above the shipped 0.933 floor.

    Real crops carry texture and background, which is why the measured same-camera negatives average
    0.83 rather than 0.97. But the dilution is real, it is the mechanism behind the 4 false links in
    `docs/reid-measurement.json`, and it is the first thing a successor descriptor should fix
    (per-block minimum, or a learned metric). `docs/reid.md` §6.
    """
    embedder = ColourConstantEmbedder()
    red = embedder.embed(car((40, 40, 200), seed=1))
    blue = embedder.embed(car((200, 60, 40), seed=1))
    assert cosine(red, blue) > 0.9, (
        "if this ever drops the descriptor has changed and the calibration must be re-run"
    )


def test_reid_embedding_rejects_a_crop_that_is_not_an_image() -> None:
    with pytest.raises(ValueError):
        ColourConstantEmbedder().embed(np.zeros((0, 0, 3), dtype=np.uint8))
    with pytest.raises(ValueError):
        ColourConstantEmbedder().embed(np.zeros((8, 8), dtype=np.uint8))


def test_reid_cosine_refuses_to_compare_different_widths() -> None:
    with pytest.raises(ValueError):
        cosine(np.zeros(4, dtype=np.float32), np.zeros(5, dtype=np.float32))


def test_reid_embedder_factory_resolves_names_and_refuses_unknown_ones() -> None:
    assert isinstance(create_embedder("colour-constant"), ColourConstantEmbedder)
    assert embedder_name("yolo") == "yolo"
    with pytest.raises(ValueError):
        create_embedder("resnet-ibn-a")


# ── colour constancy ────────────────────────────────────────────────────────────────────────────


def test_reid_shades_of_grey_pulls_two_white_balances_together() -> None:
    """The estate spans a measured luma range of 8.40 to 135.19. This is the mitigation, and the
    test asserts it *helps* — not that it fixes the problem, which it does not."""
    vehicle = car((190, 190, 190), seed=3)
    warm = under_light(vehicle, (0.75, 1.0, 1.25))
    cool = under_light(vehicle, (1.25, 1.0, 0.78))

    raw_gap = float(np.abs(warm.astype(float).mean(axis=(0, 1)) - cool.astype(float).mean(axis=(0, 1))).mean())
    balanced_gap = float(
        np.abs(
            shades_of_grey(warm).astype(float).mean(axis=(0, 1))
            - shades_of_grey(cool).astype(float).mean(axis=(0, 1))
        ).mean()
    )
    assert balanced_gap < raw_gap, "white balance correction must reduce the cross-camera colour gap"


def test_reid_shades_of_grey_leaves_a_neutral_image_alone() -> None:
    """The negative control: a correction that changes an already-neutral image is not a correction,
    it is a distortion."""
    neutral = car((128, 128, 128), seed=5)
    before = neutral.astype(float).mean(axis=(0, 1))
    after = shades_of_grey(neutral).astype(float).mean(axis=(0, 1))
    assert np.allclose(before, after, atol=3.0)


def test_reid_shades_of_grey_refuses_an_empty_image() -> None:
    with pytest.raises(ValueError):
        shades_of_grey(np.zeros((0, 0, 3), dtype=np.uint8))


# ── the spatio-temporal gate ────────────────────────────────────────────────────────────────────


def test_reid_timing_plausibility_matches_the_d3_01_model() -> None:
    """This is D3-01's `timingPlausibility` re-expressed, not a second travel-time model. If
    `packages/api/src/services/route.ts` ever changes, this test is the thing that notices."""
    assert timing_plausibility(600.0, None) is None, "unroutable is unmeasured, not implausible"
    assert timing_plausibility(600.0, 0.0) is None
    assert timing_plausibility(0.0, 600.0) == 0.0
    assert timing_plausibility(600.0, 600.0) == 1.0

    fast = math.exp(-0.5 * (math.log(0.5) / SIGMA_FAST) ** 2)
    slow = math.exp(-0.5 * (math.log(2.0) / SIGMA_SLOW) ** 2)
    assert timing_plausibility(300.0, 600.0) == pytest.approx(round(fast, 4))
    assert timing_plausibility(1200.0, 600.0) == pytest.approx(round(slow, 4))
    assert timing_plausibility(300.0, 600.0) < timing_plausibility(1200.0, 600.0), (
        "the model is asymmetric on purpose: arriving early is near-impossible, arriving late is "
        "traffic"
    )


def test_reid_gate_rejects_a_candidate_that_cannot_be_reached_in_time() -> None:
    reason = gate_reason(same_camera=False, elapsed_s=30.0, expected_travel_time_s=1800.0)
    assert reason is not None and "plausibility" in reason
    assert not passes_spatiotemporal_gate(
        same_camera=False, elapsed_s=30.0, expected_travel_time_s=1800.0
    )


def test_reid_gate_admits_a_candidate_that_can() -> None:
    """The negative control for the test above: a gate that rejected everything would pass it."""
    assert passes_spatiotemporal_gate(
        same_camera=False, elapsed_s=900.0, expected_travel_time_s=600.0
    ), "twenty minutes for a ten-minute drive is traffic, not implausibility"


def test_reid_gate_refuses_an_unroutable_pair_rather_than_guessing() -> None:
    reason = gate_reason(same_camera=False, elapsed_s=600.0, expected_travel_time_s=None)
    assert reason == "no route between the cameras — travel time unmeasured"


def test_reid_gate_refuses_a_backwards_or_over_long_gap() -> None:
    assert gate_reason(same_camera=False, elapsed_s=-1.0, expected_travel_time_s=60.0) is not None
    assert gate_reason(same_camera=True, elapsed_s=7200.0, expected_travel_time_s=None) is not None


def test_reid_gate_treats_the_same_camera_as_a_dwell_window_not_a_travel_time() -> None:
    """A camera cannot be routed to itself. Bridging across a scene cut on one camera is governed by
    a stated dwell rule, and the two claims are kept apart deliberately."""
    assert passes_spatiotemporal_gate(same_camera=True, elapsed_s=60.0, expected_travel_time_s=None)
    assert not passes_spatiotemporal_gate(
        same_camera=True, elapsed_s=600.0, expected_travel_time_s=None
    )


def test_reid_gate_runs_before_any_appearance_comparison() -> None:
    """AC 2, stated as a test.

    Two crops of *the same* synthetic vehicle — a perfect appearance match, cosine 1.0 — placed on
    two cameras 30 s apart that OSRM says are a 30-minute drive apart. The link must not happen, and
    it must not happen for a *gating* reason rather than an appearance one.
    """
    embedder = ColourConstantEmbedder()
    crop = car((150, 150, 150), seed=11)
    anchor = embedder.embed(crop)
    candidate = embedder.embed(crop)

    similarity = cosine(anchor, candidate)
    assert similarity >= REID_DEFAULTS.similarity_min, (
        "precondition: appearance alone would happily link these two"
    )

    reason = gate_reason(same_camera=False, elapsed_s=30.0, expected_travel_time_s=1800.0)
    assert reason is not None, "an unreachable candidate must be rejected despite a perfect match"


# ── gallery matching and the confidence it writes ───────────────────────────────────────────────


def test_reid_best_match_takes_the_strongest_entry_above_the_floor() -> None:
    embedder = ColourConstantEmbedder()
    query = embedder.embed(car((60, 160, 60), seed=2))
    gallery = [
        GalleryEntry("weak", "cam01", 0.0, embedder.embed(car((200, 60, 60), seed=2))),
        GalleryEntry("strong", "cam02", 0.0, embedder.embed(car((60, 160, 60), seed=2))),
    ]
    match = best_match(query, gallery)
    assert match is not None and match.sighting_id == "strong"


def test_reid_best_match_returns_nothing_on_a_hand_verified_different_pair() -> None:
    """The negative control, on real footage rather than a synthetic crop: two vehicles a human
    confirmed were on screen at the same instant must not link at the shipped threshold."""
    if not (FIXTURE_ROOT / "pairs.json").exists():
        pytest.skip("fixtures/reid-eval not built")
    manifest = load_pairs(FIXTURE_ROOT)
    embedder = ColourConstantEmbedder()
    rejected = 0
    linked = 0
    for pair in manifest["pairs"]:
        if pair["stratum"] != "same_camera_simultaneous":
            continue
        a = cv2.imread(pair["a"]["crop"])
        b = cv2.imread(pair["b"]["crop"])
        if a is None or b is None:
            continue
        gallery = [GalleryEntry(pair["a"]["instance_id"], pair["camera"], 0.0, embedder.embed(a))]
        if best_match(embedder.embed(b), gallery) is None:
            rejected += 1
        else:
            linked += 1
    assert rejected > linked, (
        f"{linked} of {rejected + linked} hand-verified distinct vehicles were linked — the "
        "measured false-link rate, and the reason the feature ships disabled by default"
    )


def test_reid_link_confidence_never_outranks_a_plate_match() -> None:
    """A re-ID bridge is the weakest link method in the system. Writing a raw 0.98 cosine into
    `identity_sightings.link_confidence` would be a lie told by a number."""
    assert link_confidence(REID_DEFAULTS.similarity_min - 0.01) == 0.0
    assert link_confidence(1.0) <= 0.6
    assert link_confidence(0.99) < link_confidence(1.0)


def test_reid_thresholds_are_overridable_without_touching_the_defaults() -> None:
    strict = ReidThresholds(similarity_min=0.999)
    assert not passes_spatiotemporal_gate(
        same_camera=True, elapsed_s=600.0, expected_travel_time_s=None, thresholds=strict
    )
    assert REID_DEFAULTS.similarity_min == 0.933, (
        "the shipped threshold is the calibration's output; changing it needs a re-run of eval_reid"
    )


# ── the labelled set ────────────────────────────────────────────────────────────────────────────


def test_reid_fixture_carries_the_labelled_pairs_the_ticket_requires() -> None:
    """AC 3's arithmetic, asserted rather than asserted-about: >= 30 positive and >= 30 negative."""
    if not (FIXTURE_ROOT / "pairs.json").exists():
        pytest.skip("fixtures/reid-eval not built")
    manifest = load_pairs(FIXTURE_ROOT)
    positives = [p for p in manifest["pairs"] if p["label"] == "same"]
    negatives = [
        p
        for p in manifest["pairs"]
        if p["label"] == "different"
        and p["stratum"] in ("same_camera_simultaneous", "tracker_id_switch")
    ]
    assert len(positives) >= 30, f"only {len(positives)} positive pairs"
    assert len(negatives) >= 30, f"only {len(negatives)} negative pairs"
    assert all(p["stratum"] == "same_camera_pass" for p in positives)


def test_reid_fixture_records_that_cross_camera_positives_do_not_exist_here() -> None:
    """The limitation is part of the fixture, not a footnote somebody can drop when quoting the
    precision figure."""
    if not (FIXTURE_ROOT / "pairs.json").exists():
        pytest.skip("fixtures/reid-eval not built")
    manifest = load_pairs(FIXTURE_ROOT)
    assert "no_cross_camera_positives" in manifest
    assert not [
        p
        for p in manifest["pairs"]
        if p["label"] == "same" and p["a"]["camera"] != p["b"]["camera"]
    ], "a cross-camera positive would need a plate anchor this estate does not provide"


def test_reid_fixture_crops_all_exist_on_disk() -> None:
    if not (FIXTURE_ROOT / "pairs.json").exists():
        pytest.skip("fixtures/reid-eval not built")
    manifest = load_pairs(FIXTURE_ROOT)
    missing = [
        side["crop"]
        for pair in manifest["pairs"]
        for side in (pair["a"], pair["b"])
        if not pathlib.Path(side["crop"]).exists()
    ]
    assert not missing, f"{len(missing)} referenced crops are missing, first {missing[:1]}"


def test_reid_measured_precision_is_published_and_matches_the_shipped_default() -> None:
    """The measurement is committed alongside the code, so a reader does not have to re-run a
    six-fold sweep to find out what the number was — and so a threshold change that is not
    re-measured fails a test instead of quietly shipping."""
    measured = pathlib.Path("docs/reid-measurement.json")
    if not measured.exists():
        pytest.skip("docs/reid-measurement.json not written")
    result = json.loads(measured.read_text(encoding="utf-8"))
    assert result["shipped"]["threshold"] == REID_DEFAULTS.similarity_min
    assert result["held_out"]["precision"] is not None
    if result["held_out"]["precision"] < result["target"]:
        assert result["meets_target"] is False, (
            "a sub-target precision must be recorded as a miss, never rounded into a pass"
        )
