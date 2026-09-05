#!/usr/bin/env python3
"""Generate ``fixtures/watchlist-seed.csv`` — the representative watchlist dataset (D2-05).

The challenge's problem statement says participants *"may create and use their own representative
watchlist database"*. This builds one, deterministically, so the committed CSV can be regenerated
and audited rather than being 200 opaque lines someone typed once.

**Nothing here is real.** No row describes a real vehicle, a real person or a real case. Owners and
subjects are *references* (``VAHAN-OWNER-0042``, ``SUBJECT-0117``), never names, because a
representative dataset does not need invented people and inventing them is how a demo turns into a
fabricated record. **No biometric field is emitted for any row**, AFIS and NAFIS included: those two
systems appear as subject *references* only, which is the whole of what SAAKSHI would ever hold from
them.

Two blocks are different, and are marked as such in every row's ``note``:

``estate-groundtruth``
    The plate registrations a **human** read off the sandbox feeds — D2-01's hand-labelled set and
    the D0-01 recon frames. These genuinely appear on the estate.

``estate-ocr-output``
    Strings the ANPR pipeline **actually emitted** on the live run. They are seeded so D2-06's alert
    engine can fire a real end-to-end alert against the real estate instead of only against
    fixtures. They were selected from measured output, **not from a vehicle registry**, and several
    are fragments rather than registrations. Provenance is in the row.

Usage::

    python3 scripts/gen-watchlist-seed.py            # writes fixtures/watchlist-seed.csv
"""

from __future__ import annotations

import csv
import random
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

SEED = 20260905
OUT = Path(__file__).resolve().parent.parent / "fixtures" / "watchlist-seed.csv"

# Reference window. Fixed dates rather than "now" so the committed CSV is byte-stable and a diff
# means someone changed the data, not that a day passed.
FROM_DEFAULT = "2026-01-01T00:00:00Z"
EXPIRED_TO = "2026-06-01T00:00:00Z"
FUTURE_TO = "2027-12-31T00:00:00Z"


@dataclass
class Row:
    """One CSV line. Column order is the header order; the API importer reads it by name."""

    source_system: str
    source_ref: str
    category: str
    entity_type: str
    plate: str = ""
    person_ref: str = ""
    severity: str = "medium"
    valid_from: str = FROM_DEFAULT
    valid_to: str = ""
    active: str = "true"
    # VAHAN — vehicle record
    make: str = ""
    model: str = ""
    colour: str = ""
    owner_ref: str = ""
    rc_status: str = ""
    # SARTHI — driving licence
    dl_no: str = ""
    holder_ref: str = ""
    dl_valid_to: str = ""
    # eGujCop (CCTNS) — case record
    fir_ref: str = ""
    police_station: str = ""
    wanted_status: str = ""
    # AFIS / NAFIS — subject reference ONLY. No biometric field exists in this schema.
    subject_ref: str = ""
    note: str = ""
    provenance: str = "synthetic"


MAKES = [
    ("Maruti Suzuki", "Swift"),
    ("Maruti Suzuki", "Alto"),
    ("Maruti Suzuki", "Ertiga"),
    ("Hyundai", "i20"),
    ("Hyundai", "Creta"),
    ("Tata", "Nexon"),
    ("Tata", "Ace"),
    ("Mahindra", "Bolero"),
    ("Mahindra", "Scorpio"),
    ("Honda", "City"),
    ("Toyota", "Innova"),
    ("Bajaj", "Pulsar"),
    ("Hero", "Splendor"),
    ("TVS", "Jupiter"),
    ("Ashok Leyland", "Dost"),
    ("Eicher", "Pro 2049"),
]
COLOURS = ["white", "silver", "grey", "black", "blue", "red", "brown", "maroon", "yellow"]
# Gujarat RTO codes, plus the neighbouring states a highway camera in Ahmedabad genuinely sees.
GJ_RTO = [f"{n:02d}" for n in range(1, 39)]
OTHER_STATES = [("RJ", ["14", "39", "45"]), ("MH", ["01", "12", "43"]), ("MP", ["09", "04"])]
STATIONS = [
    "Vastrapur PS",
    "Navrangpura PS",
    "Satellite PS",
    "Ghatlodia PS",
    "Naroda PS",
    "Odhav PS",
    "Sabarmati PS",
    "Bopal PS",
    "Ranip PS",
    "Maninagar PS",
]


def plate(rng: random.Random) -> str:
    """A structurally valid Indian registration: ``<2 alpha><2 digit><1-2 alpha><4 digit>``."""
    if rng.random() < 0.85:
        state, rto = "GJ", rng.choice(GJ_RTO)
    else:
        state, codes = rng.choice(OTHER_STATES)
        rto = rng.choice(codes)
    series_len = rng.choice([1, 2, 2, 2])
    series = "".join(rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") for _ in range(series_len))
    return f"{state}{rto}{series}{rng.randint(1000, 9999)}"


def vehicle_rows(rng: random.Random, seen: set[str]) -> list[Row]:
    """Stolen and blacklisted vehicles — the two vehicle categories."""
    rows: list[Row] = []
    plan = [
        # (category, count, source_system, severity, wanted_status)
        ("stolen_vehicle", 70, "VAHAN", "high", "stolen"),
        ("blacklisted_vehicle", 46, "eGujCop", "medium", "blacklisted"),
    ]
    for category, count, system, severity, status in plan:
        for i in range(1, count + 1):
            p = plate(rng)
            while p in seen:
                p = plate(rng)
            seen.add(p)
            make, model = rng.choice(MAKES)
            # A tenth of the set carries a closed validity window on purpose: an expired entry that
            # still matched would be the exact bug the validity-window AC exists to catch, and a
            # dataset with no expired rows cannot demonstrate that it does not.
            expired = i % 10 == 0
            rows.append(
                Row(
                    source_system=system,
                    source_ref=f"{'VH' if system == 'VAHAN' else 'BL'}-{category[:3].upper()}-{i:04d}",
                    category=category,
                    entity_type="vehicle",
                    plate=p,
                    severity="critical" if i % 17 == 0 else severity,
                    valid_to=EXPIRED_TO if expired else (FUTURE_TO if i % 3 == 0 else ""),
                    make=make,
                    model=model,
                    colour=rng.choice(COLOURS),
                    owner_ref=f"VAHAN-OWNER-{rng.randint(1, 9999):04d}",
                    rc_status="suspended" if category == "blacklisted_vehicle" else "active",
                    fir_ref=f"FIR/{rng.randint(2024, 2026)}/{rng.randint(1, 999):03d}",
                    police_station=rng.choice(STATIONS),
                    wanted_status=status,
                    note=f"synthetic {category.replace('_', ' ')} record{' — window closed' if expired else ''}",
                )
            )
    return rows


def person_rows(rng: random.Random) -> list[Row]:
    """Wanted, missing and suspect — person categories, held as references only.

    ``person_ref`` is an opaque case reference. ``subject_ref`` is the identifier under which AFIS
    or NAFIS holds a subject — a pointer, never a template. There is no name field, no photograph
    field and no biometric field anywhere in this schema.
    """
    rows: list[Row] = []
    plan = [
        ("wanted_person", 40, "eGujCop", "high", "wanted"),
        ("missing_person", 30, "eGujCop", "medium", "missing"),
        ("suspect", 26, "NAFIS", "low", "under_investigation"),
    ]
    for category, count, system, severity, status in plan:
        for i in range(1, count + 1):
            expired = i % 10 == 0
            afis = category == "missing_person"
            rows.append(
                Row(
                    source_system="AFIS" if afis and i % 3 == 0 else system,
                    source_ref=f"{category[:2].upper()}-{i:04d}",
                    category=category,
                    entity_type="person",
                    person_ref=f"CASE/{category[:2].upper()}/{2025 + (i % 2)}/{i:04d}",
                    severity="critical" if i % 13 == 0 else severity,
                    valid_to=EXPIRED_TO if expired else (FUTURE_TO if i % 4 == 0 else ""),
                    fir_ref=f"FIR/{rng.randint(2024, 2026)}/{rng.randint(1, 999):03d}",
                    police_station=rng.choice(STATIONS),
                    wanted_status=status,
                    subject_ref=f"{'AFIS' if afis else 'NAFIS'}-SUBJECT-{i:05d}",
                    note=(
                        "reference-only subject record — SAAKSHI processes no biometrics and "
                        "performs no face recognition"
                    ),
                )
            )
    return rows


def driver_rows(rng: random.Random) -> list[Row]:
    """SARTHI — driving-licence records, so the connector's field shape is exercised by real rows."""
    rows: list[Row] = []
    for i in range(1, 13):
        rows.append(
            Row(
                source_system="SARTHI",
                source_ref=f"DL-{i:04d}",
                category="suspect",
                entity_type="person",
                person_ref=f"CASE/DL/2026/{i:04d}",
                severity="low",
                valid_to=FUTURE_TO,
                dl_no=f"GJ{rng.randint(1, 38):02d} {rng.randint(20150000000, 20249999999)}",
                holder_ref=f"SARTHI-HOLDER-{i:05d}",
                dl_valid_to=f"{2027 + (i % 4)}-0{1 + (i % 9)}-15",
                wanted_status="licence_flagged",
                note="synthetic driving-licence flag — holder held as a reference, never a name",
            )
        )
    return rows


# ── The estate blocks ───────────────────────────────────────────────────────────────────────────
#
# Everything below is measured, and each row says how it was measured.

GROUNDTRUTH = [
    # (plate, camera, evidence id, how it was verified)
    (
        "GJ12EC7928",
        "cam30",
        "day_cam30_042_00",
        "hand-labelled ground truth, 76 px daylight plate — fixtures/plate-eval/labels.json",
    ),
    (
        "GJ32D0107",
        "cam07",
        "night_cam07_111_02",
        "hand-labelled ground truth, 56 px streetlit plate — fixtures/plate-eval/labels.json",
    ),
    (
        "GJ35U0779",
        "cam07",
        "night_cam07_102_02",
        "hand-labelled ground truth, 52 px streetlit plate — fixtures/plate-eval/labels.json",
    ),
    (
        "RJ39CA5180",
        "cam21",
        "d0-01-recon",
        "human-legible in the D0-01 recon frame — docs/anpr-accuracy.md §7",
    ),
]

OCR_OUTPUT = [
    # (string, confidence, camera) — from the 5-minute 8-camera live run, docs/anpr-accuracy.md §8.
    # The two hoarding phone numbers (757508300, 755508000) are deliberately NOT seeded: they are
    # signage, and putting them on a watchlist would manufacture an alert with no vehicle behind it.
    ("GJ3266416", 0.449, "cam07"),
    ("AAM412", 0.503, "cam-unattributed"),
    ("44671", 0.732, "cam08"),
    ("1118R", 0.627, "cam-unattributed"),
    ("46101", 0.560, "cam-unattributed"),
]


def estate_rows() -> list[Row]:
    rows: list[Row] = []
    for idx, (plate_text, camera, evidence, how) in enumerate(GROUNDTRUTH, start=1):
        rows.append(
            Row(
                source_system="eGujCop",
                source_ref=f"ESTATE-GT-{plate_text}",
                category="stolen_vehicle",
                entity_type="vehicle",
                plate=plate_text,
                severity="high",
                rc_status="unknown",
                wanted_status="stolen",
                police_station="Vastrapur PS",
                # Fixed, not hashed: PYTHONHASHSEED is randomised per process, so a hash here would
                # rewrite the committed CSV on every run and make a real diff invisible.
                fir_ref=f"FIR/2026/{900 + idx:03d}",
                note=(
                    f"ESTATE GROUND TRUTH — this registration genuinely appears on sandbox feed "
                    f"{camera} ({evidence}): {how}. The watchlist *status* is synthetic; the plate "
                    f"is not."
                ),
                provenance="estate-groundtruth",
            )
        )
    for text, conf, camera in OCR_OUTPUT:
        rows.append(
            Row(
                source_system="manual",
                source_ref=f"ESTATE-OCR-{text}",
                category="blacklisted_vehicle",
                entity_type="vehicle",
                plate=text,
                severity="low",
                rc_status="unknown",
                wanted_status="watch_only",
                note=(
                    f"SELECTED FROM MEASURED ANPR OUTPUT, NOT FROM A VEHICLE REGISTRY — the live "
                    f"run emitted '{text}' at confidence {conf} on {camera} "
                    f"(docs/anpr-accuracy.md §8). Seeded so D2-06 can fire a real end-to-end alert "
                    f"against the real estate. Several of these are fragments, not registrations."
                ),
                provenance="estate-ocr-output",
            )
        )
    # Two purpose-built validity fixtures, so "an expired entry must not alert" is demonstrable
    # straight after seeding rather than only inside a unit test.
    rows.append(
        Row(
            source_system="manual",
            source_ref="SEED-VALIDITY-EXPIRED",
            category="stolen_vehicle",
            entity_type="vehicle",
            plate="GJ01XX0001",
            severity="critical",
            valid_from=FROM_DEFAULT,
            valid_to=EXPIRED_TO,
            rc_status="active",
            note="validity fixture: window closed 2026-06-01, must never produce a hit after it",
            provenance="validity-fixture",
        )
    )
    rows.append(
        Row(
            source_system="manual",
            source_ref="SEED-VALIDITY-OPEN",
            category="stolen_vehicle",
            entity_type="vehicle",
            plate="GJ01XX0002",
            severity="critical",
            valid_from=FROM_DEFAULT,
            valid_to="",
            rc_status="active",
            note="validity fixture: open-ended window, the control for SEED-VALIDITY-EXPIRED",
            provenance="validity-fixture",
        )
    )
    return rows


def main() -> None:
    rng = random.Random(SEED)
    seen: set[str] = {p for p, _, _, _ in GROUNDTRUTH} | {t for t, _, _ in OCR_OUTPUT}
    seen |= {"GJ01XX0001", "GJ01XX0002"}

    rows = vehicle_rows(rng, seen) + person_rows(rng) + driver_rows(rng) + estate_rows()

    header = [f.name for f in fields(Row)]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=header, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))

    by_category: dict[str, int] = {}
    for row in rows:
        by_category[row.category] = by_category.get(row.category, 0) + 1
    print(f"wrote {len(rows)} rows -> {OUT}")
    for category, count in sorted(by_category.items()):
        print(f"  {category:22s} {count}")


if __name__ == "__main__":
    main()
