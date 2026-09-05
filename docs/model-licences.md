# Model weights and their licences

Every model this system runs, where its weights come from, and under what licence. The challenge's
About page states that solutions *should* use open-source technologies; this file is the evidence
that they do, at the layer where it is easiest to get wrong — pre-trained weights are routinely
published under terms that differ from the code that loads them.

**Nothing here is proprietary and nothing here is licence-restricted for commercial or government
use.** Weights are gitignored (`models/`, `*.pt`, `*.onnx`) and fetched at first run, so this table
is the audit trail rather than the binaries.

Licences were read from the upstream repositories on **2026-09-05**, not from memory.

| Model | Role | Weights source | Licence | Verified |
|---|---|---|---|---|
| **YOLO11n** (`models/yolo11n.pt`) | Vehicle detection (D1-09) | ultralytics, fetched by `make models` | **AGPL-3.0** — see the note below | ultralytics/ultralytics `LICENSE` |
| **YOLO-v9-s 608 license-plate end2end** (`yolo-v9-s-608-license-plates-end2end.onnx`) | Plate detection (D2-01) | `ankandrew/open-image-models` release assets | **MIT** | GitHub licence API, repo `open-image-models` |
| **`cct-s-v2-global`, `cct-xs-v1-global`** (`.onnx` + plate config) | OCR — `fast_plate_ocr` backend | `ankandrew/fast-plate-ocr` release assets (published under the repo's former name `cnn-ocr-lp`) | **MIT** | GitHub licence API, repo `fast-plate-ocr` |
| **PP-OCRv6 det/rec/cls** (`PP-OCRv6_det_small.onnx`, `PP-OCRv6_rec_small.onnx`, `ch_ppocr_mobile_v2.0_cls_mobile.onnx`) | OCR — `paddle_ppocr` backend | shipped with / fetched by `rapidocr` | **Apache-2.0** (PaddleOCR models; RapidOCR's port is Apache-2.0) | RapidOCR and PaddleOCR `LICENSE` |

## The libraries that load them

| Package | Version pinned | Licence |
|---|---|---|
| `ultralytics` | `>=8.3` | AGPL-3.0 |
| `open-image-models` | `>=0.6.0` | MIT (`License-Expression` in the wheel metadata) |
| `fast-plate-ocr[onnx]` | `>=1.1.0` | MIT (`License-Expression` in the wheel metadata) |
| `rapidocr` | `>=3.4` | Apache-2.0 |
| `onnxruntime` | `>=1.29` | MIT |
| `supervision` (ByteTrack) | `>=0.23,<0.31` | MIT |
| `av` (PyAV) | `>=13.0` | BSD-3-Clause |
| `opencv-python` | `>=4.10` | Apache-2.0 |

## Two notes that matter for a government deployment

**1 · ultralytics is AGPL-3.0, and that is a real constraint, not a formality.** AGPL obliges the
operator to offer the corresponding source of a *networked* service built on it. For SAAKSHI, whose
source is published, this is satisfied by publishing the repository. It is recorded here rather
than buried because a police department that later wants to run a closed fork would need either an
ultralytics commercial licence or a differently-licensed detector — and that is a procurement
decision, not an engineering detail. The plate detector and both OCR engines are MIT/Apache-2.0, so
**only the vehicle-detection stage carries the copyleft**, and it is the stage with the most
drop-in alternatives.

**2 · "PaddleOCR" here means PaddleOCR's models, not the PaddlePaddle runtime.** The `paddle_ppocr`
backend runs the PP-OCR detection and recognition weights through ONNX Runtime via RapidOCR.
Installing `paddlepaddle` + `paddleocr` proper would downgrade `numpy` 2.5.2 -> 2.3.5 and add a
second OpenCV to this repo's shared virtualenv, which is a large change to every worker's
environment in exchange for a fallback path. The weights, and therefore the recognition behaviour,
are PaddleOCR's; the runtime is not. `workers/analytics/anpr/ocr.py` says the same thing at the
point of use, so nobody reads "PaddleOCR" in a slide and infers a PaddlePaddle dependency that is
not there.

## No biometric models

There is **no face recognition model in this system, and there will not be one.** It is deliberately
out of scope (`CLAUDE.md`): it is not mandated by the challenge, and it needs separate legal
authorisation. No model in the table above processes biometric data. `person` appears as a detector
class only as a bounding box — a pedestrian near a vehicle of interest is context — and no identity
is derived from it.
