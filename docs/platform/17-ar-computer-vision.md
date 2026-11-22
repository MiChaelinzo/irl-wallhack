# 17 AR and computer vision

Status: **DESIGN ONLY.** No AR code, no camera code and no computer-vision code for floor plans exists in the repository. What exists and could be reused is listed per idea. All ideas need a privacy review: camera data must stay on the device by default (the project's consent stance).

## 1. Camera room scan

Idea: build a rough room outline from phone sensors. Options: WebXR plane detection (browser support varies, general knowledge, not checked here), or the user walking the perimeter while tapping corners. The second needs no computer vision and fits the existing planner: the output is walls in the project schema. Reuse: wall and room schema (`planner-state.js`), the mobile page (`wallhack/static/mobile.html`). Risk: scale accuracy, UNVERIFIED.

## 2. Floor plan extraction from an uploaded image

The planner already imports a background image and lets the user calibrate the scale (`planner-editor.js`, `scale_m_per_px` in `twin.py`). Extraction means detecting wall lines in that image. Approach: classical pipeline (threshold, morphological cleanup, Hough line transform) in the browser canvas or in Python with OpenCV, which is optional and already used by the QR tests (`opencv-python-headless` in CI only). Output: candidate walls with a confidence, shown as a preview the user accepts or edits, always undoable. A learned model would add a heavy dependency and a model file, which the steering says not to add without approval. Honest limitation: hand-drawn or photographed plans will fail often, so the review step is mandatory.

## 3. AR router placement

Idea: point the phone at a wall, see the predicted coverage as an overlay, move a virtual AP. Needs device pose (WebXR or sensors), a registration between the camera world and the plan (tap two known points, or the QR calibration below), and the engine heat map as a texture. The engine already computes the grid in the browser, so the overlay data exists. Missing: tracking and registration. Mobile browsers, HTTPS requirements for camera access and the plain-HTTP LAN pairing do not mix well (secure context needed, general knowledge), so this would need a TLS story first. UNVERIFIED feasibility.

## 4. Smartphone coverage test

The mobile companion (`wallhack/static/mobile.html`, `mobile.js`) is paired over LAN with a token (`wallhack/pairing.py`). A browser cannot read Wi-Fi RSSI (web platform limitation, general knowledge). Practical options: a measured throughput or latency probe to the server at tapped positions (measurable in a browser), or manual dBm entry from a phone's own Wi-Fi tool. Both produce survey points that feed model calibration (a high-value NOT BUILT item in [21-top-100-improvements.md](21-top-100-improvements.md)). Latency and throughput are not RSSI, so they are a different quantity and must be labelled so.

## 5. QR calibration

`wallhack/qr.py` encodes QR codes (versions 1 to 6, level M, tested with OpenCV decode when installed). Idea: print a QR of known physical size, photograph it next to the floor plan or place it on the wall, and derive scale from its pixel size. Needs a QR decoder with corner positions in the browser (not present: `qr.py` only encodes). BarcodeDetector exists in some browsers (general knowledge, support varies). Fallback: the existing manual calibrate tool. Value: small, convenience only.

## Order of value

1. Survey points from the phone (feeds calibration, uses existing pairing).
2. Floor plan extraction with review.
3. QR scale calibration.
4. AR overlay (needs the most infrastructure, best demo).
