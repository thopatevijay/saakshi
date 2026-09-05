"""The evaluation-set builder.

Only the parts that can make the *measurement* wrong are tested here — the capture step is an
ffmpeg invocation against a live gateway and is exercised by building the set, not by a unit test.

Deduplication is the one with teeth. At 2 fps a vehicle crossing a junction appears in six
consecutive frames, so without it a set of "50 hand-labelled plates" would be eight vehicles seen
repeatedly, and the enriched stratum would be six views of the same car. Every count in
`docs/anpr-accuracy.md` rests on this.
"""

from __future__ import annotations

from workers.analytics.anpr.dataset import DEDUPE_WINDOW_FRAMES, Instance, deduplicate


def instance(
    ident: str, camera: str, frame: str, box: list[float], plate_width: float | None = None
) -> Instance:
    return Instance(
        id=ident,
        camera=camera,
        condition="day",
        frame=frame,
        resolution="854x480",
        vehicle_class="car",
        vehicle_box=box,
        vehicle_crop=f"crops/{ident}_vehicle.png",
        plate_width_px=plate_width,
    )


def test_one_vehicle_across_consecutive_frames_becomes_one_instance() -> None:
    pool = [
        instance("a1", "cam21", "day_cam21_001.jpg", [100, 100, 80, 60], 22.0),
        instance("a2", "cam21", "day_cam21_002.jpg", [104, 101, 80, 60], 30.0),
        instance("a3", "cam21", "day_cam21_003.jpg", [108, 102, 80, 60], 26.0),
    ]

    kept = deduplicate(pool)

    assert len(kept) == 1
    # The pass is represented by its best evidence, not by whichever frame came first.
    assert kept[0].id == "a2"
    assert kept[0].plate_width_px == 30.0
    # …and it remembers the whole pass, which is what AC 1's comparison needs.
    assert len(kept[0].pass_crops) == 3


def test_two_vehicles_in_the_same_frame_stay_two_instances() -> None:
    pool = [
        instance("a", "cam21", "day_cam21_001.jpg", [100, 100, 80, 60], 22.0),
        instance("b", "cam21", "day_cam21_001.jpg", [400, 300, 90, 70], 40.0),
    ]

    assert len(deduplicate(pool)) == 2


def test_the_same_position_on_two_cameras_is_two_vehicles() -> None:
    pool = [
        instance("a", "cam21", "day_cam21_001.jpg", [100, 100, 80, 60]),
        instance("b", "cam06", "day_cam06_001.jpg", [100, 100, 80, 60]),
    ]

    assert len(deduplicate(pool)) == 2


def test_the_same_lane_much_later_is_a_different_vehicle() -> None:
    """A car stopped at the same signal three minutes later is not the same car."""
    pool = [
        instance("a", "cam21", "day_cam21_001.jpg", [100, 100, 80, 60]),
        instance(
            "b", "cam21", f"day_cam21_{DEDUPE_WINDOW_FRAMES + 2:03d}.jpg", [100, 100, 80, 60]
        ),
    ]

    assert len(deduplicate(pool)) == 2


def test_a_pass_with_no_plate_is_still_one_instance() -> None:
    """Vehicles the plate detector never fired on are the estate's real answer, not a gap."""
    pool = [
        instance("a1", "cam04", "day_cam04_001.jpg", [10, 10, 60, 50]),
        instance("a2", "cam04", "day_cam04_002.jpg", [12, 11, 60, 50]),
    ]

    kept = deduplicate(pool)

    assert len(kept) == 1
    assert kept[0].plate_width_px is None
    assert len(kept[0].pass_crops) == 2
