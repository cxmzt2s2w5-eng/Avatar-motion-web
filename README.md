# Avatar Motion Web

Real-time webcam motion capture in the browser. Your body movement is tracked
from the camera and retargeted live onto a 3D avatar — no plugins, no install,
runs entirely client-side.

**Live demo:** _add your deployment link here_

![Avatar Motion Web](https://img.shields.io/badge/Three.js-r166-black) ![MediaPipe](https://img.shields.io/badge/MediaPipe-Pose-00C4CC)

## What it does

- Captures the webcam and runs **MediaPipe Pose** to detect 33 body landmarks.
- Retargets the pose onto a rigged **Mixamo** humanoid avatar in real time using
  **Three.js** — arms, torso, head follow your movement.
- Switch between multiple avatars on the fly.

## Tech

- **Three.js** (WebGL rendering, GLTF avatars)
- **MediaPipe Pose** (browser pose estimation)
- Vanilla JS / HTML / CSS — fully static, no build step

## How the retargeting works

Bones are aimed directionally with quaternions: for each limb segment the
direction between two pose landmarks is converted into the bone's local space
(using the bone's real rest direction), so the same code works for any rig.
Models are auto-normalized on load (scaled to a common height and centered),
and arms fall back to a natural relaxed pose when they leave the frame.

## Run locally

The app needs a local server (the camera API and ES modules don't work from
`file://`):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Allow camera access, press **Запустить камеру**, and move.

## Credits

Avatars from [Mixamo](https://www.mixamo.com/). Pose tracking by
[MediaPipe](https://developers.google.com/mediapipe).
