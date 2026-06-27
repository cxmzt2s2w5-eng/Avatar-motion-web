import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const startButton = document.querySelector("#start-button");
const stopButton = document.querySelector("#stop-button");
const statusText = document.querySelector("#status");
const trackingStatus = document.querySelector("#tracking-status");
const avatarName = document.querySelector("#avatar-name");
const cameraVideo = document.querySelector("#camera");
const poseCanvas = document.querySelector("#pose-canvas");
const poseContext = poseCanvas.getContext("2d");
const avatarCanvas = document.querySelector("#avatar-canvas");
const avatarButtons = document.querySelectorAll(".avatar-button");

let poseDetector = null;
let cameraStream = null;
let latestPose = null;
let isTracking = false;
let activeAvatarIndex = 0;
let currentModel = null;
let currentRig = null;

// --- Framing / retarget config ---------------------------------------------
// Every avatar is normalized to this world height and centered on BASE_Y,
// so the baked-in scale/offset inside each GLB no longer matters.
const TARGET_HEIGHT = 3.0;
const BASE_Y = 1.1; // совпадает с camera.lookAt — модель в центре кадра

// ЕДИНЫЙ переключатель горизонтали для ВСЕГО (руки, корпус, голова).
// Если лево/право перепутаны (сводишь руки — они разводятся) — поменяй MIRROR_X на -1.
// Этого одного флага достаточно: все горизонтальные оси согласованы между собой.
const MIRROR_X = 1;
const ARM_SWAP = false;   // запасной флаг: меняет какую руку аватара ведёт какая рука пользователя
const DEPTH_WEIGHT = 0.6; // вклад глубины MediaPipe (шумная, держим небольшой)

const avatars = [
    {
        name: "Avatar 1",
        file: "./models/avatar1.glb",
        scale: 1,
        rotationY: 0
    },
    {
        name: "Avatar 2",
        file: "./models/avatar3.glb",
        scale: 1,
        rotationY: 0
    }
];

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020813);

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
camera.position.set(0, 1.25, 7.2);
camera.lookAt(0, 1.1, 0);

const renderer = new THREE.WebGLRenderer({
    canvas: avatarCanvas,
    antialias: true,
    alpha: false
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const avatarRoot = new THREE.Group();
const basePosition = new THREE.Vector3(0, BASE_Y, 0);
avatarRoot.position.copy(basePosition);
scene.add(avatarRoot);

const floor = new THREE.Mesh(
    new THREE.CircleGeometry(1.7, 64),
    new THREE.MeshStandardMaterial({
        color: 0x102134,
        roughness: 0.8,
        metalness: 0.05
    })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = BASE_Y - TARGET_HEIGHT / 2 - 0.02; // под ногами нормализованной модели
scene.add(floor);

const ambientLight = new THREE.HemisphereLight(0xffffff, 0x172033, 2.7);
scene.add(ambientLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 4.2);
keyLight.position.set(0, 3.2, 5.5);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 2.0);
fillLight.position.set(-4, 2, 3);
scene.add(fillLight);

const rimLight = new THREE.PointLight(0x63e6be, 20, 8);
rimLight.position.set(-3, 2.2, 2);
scene.add(rimLight);

const loader = new GLTFLoader();

resizeScene();
loadAvatar(0);
animate();

startButton.addEventListener("click", startApplication);
stopButton.addEventListener("click", stopApplication);

avatarButtons.forEach(function (button) {
    button.addEventListener("click", function () {
        loadAvatar(Number(button.dataset.avatar));
    });
});

window.addEventListener("resize", function () {
    resizeScene();
    resizePoseCanvas();
});

async function loadAvatar(index) {
    activeAvatarIndex = index;
    const avatar = avatars[index];

    statusText.textContent = `Загружаю ${avatar.name}...`;
    avatarName.textContent = avatar.name;

    avatarButtons.forEach(function (button) {
        button.classList.toggle("active", Number(button.dataset.avatar) === activeAvatarIndex);
    });

    if (currentModel) {
        avatarRoot.remove(currentModel);
        disposeModel(currentModel);
        currentModel = null;
        currentRig = null;
    }

    // сбрасываем трансформ, чтобы центрирование модели было точным
    avatarRoot.rotation.set(0, 0, 0);
    avatarRoot.position.copy(basePosition);

    loader.load(
        avatar.file,
        function (gltf) {
            currentModel = gltf.scene;

            currentModel.traverse(function (object) {
                if (object.isMesh) {
                    object.castShadow = true;
                    object.frustumCulled = false; // скиннинг + увеличенный bbox => не отсекать

                    if (object.material) {
                        const materials = Array.isArray(object.material) ? object.material : [object.material];

                        materials.forEach(function (material) {
                            material.side = THREE.DoubleSide;

                            // Запечённая metallicRoughness-текстура делает персонажа
                            // глянцевым и тёмным (глянец отражает тёмный фон). Игнорируем
                            // её и ставим равномерный матовый материал. Albedo и normal-карта
                            // остаются — детали поверхности сохраняются.
                            material.metalness = 0;
                            material.roughness = 0.78;
                            material.metalnessMap = null;
                            material.roughnessMap = null;

                            if (material.map) {
                                material.map.colorSpace = THREE.SRGBColorSpace;
                            }

                            material.needsUpdate = true;
                        });
                    }
                }
            });

            avatarRoot.add(currentModel);
            fitModel(currentModel, avatar.rotationY);
            currentRig = createRig(currentModel);
            statusText.textContent = `Выбран персонаж: ${avatar.name}`;
        },
        function (progress) {
            if (progress.total > 0) {
                const percent = Math.round((progress.loaded / progress.total) * 100);
                statusText.textContent = `Загружаю ${avatar.name}: ${percent}%`;
            } else {
                statusText.textContent = `Загружаю ${avatar.name}...`;
            }
        },
        function (error) {
            console.error(error);
            statusText.textContent = `Не удалось загрузить ${avatar.name}. Проверь папку models и запусти сайт через localhost.`;
        }
    );
}

async function startApplication() {
    startButton.disabled = true;
    startButton.textContent = "Запускаю...";
    stopButton.disabled = true;
    statusText.textContent = "Браузер запрашивает доступ к камере";

    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: 1280,
                height: 720
            },
            audio: false
        });

        cameraVideo.srcObject = cameraStream;
        await waitForVideo(cameraVideo);
        resizePoseCanvas();

        startButton.textContent = "Камера работает";
        stopButton.disabled = false;
        statusText.textContent = "Камера включена. Загружаю отслеживание позы...";

        try {
            await setupPoseDetector();

            isTracking = true;
            trackingStatus.textContent = "Pose tracking: on";
            statusText.textContent = "Готово: двигай руками, головой и корпусом";
            detectPoseLoop();
        } catch (poseError) {
            console.error(poseError);
            trackingStatus.textContent = "Pose tracking: unavailable";
            statusText.textContent = "Камера работает, но отслеживание позы не загрузилось. Проверь интернет и обнови страницу.";
        }
    } catch (cameraError) {
        console.error(cameraError);
        startButton.disabled = false;
        startButton.textContent = "Попробовать снова";
        stopButton.disabled = true;
        trackingStatus.textContent = "Pose tracking: off";
        statusText.textContent = "Не получилось запустить камеру. Проверь разрешение в браузере.";
    }
}

function stopApplication() {
    isTracking = false;
    latestPose = null;
    poseDetector = null;
    poseContext.clearRect(0, 0, poseCanvas.width, poseCanvas.height);

    if (cameraStream) {
        cameraStream.getTracks().forEach(function (track) {
            track.stop();
        });
    }

    cameraStream = null;
    cameraVideo.srcObject = null;

    startButton.disabled = false;
    startButton.textContent = "Запустить камеру";
    stopButton.disabled = true;
    trackingStatus.textContent = "Pose tracking: off";
    statusText.textContent = "Камера выключена";
}

function waitForVideo(videoElement) {
    return new Promise(function (resolve) {
        videoElement.onloadedmetadata = function () {
            videoElement.play();
            resolve();
        };
    });
}

async function setupPoseDetector() {
    if (window.Pose && window.drawConnectors && window.drawLandmarks) {
        createPoseDetector();
        return;
    }

    await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js");
    await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js");
    createPoseDetector();
}

function createPoseDetector() {
    poseDetector = new window.Pose({
        locateFile: function (file) {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`;
        }
    });

    poseDetector.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        enableSegmentation: false,
        minDetectionConfidence: 0.55,
        minTrackingConfidence: 0.55
    });

    poseDetector.onResults(function (results) {
        latestPose = results.poseLandmarks || null;
        drawPose(results);
    });
}

function loadScript(source) {
    return new Promise(function (resolve, reject) {
        const script = document.createElement("script");
        script.src = source;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

async function detectPoseLoop() {
    if (!isTracking || !poseDetector || !cameraVideo.srcObject) {
        return;
    }

    await poseDetector.send({
        image: cameraVideo
    });

    requestAnimationFrame(detectPoseLoop);
}

function drawPose(results) {
    poseContext.clearRect(0, 0, poseCanvas.width, poseCanvas.height);

    if (!results.poseLandmarks || !window.drawConnectors || !window.drawLandmarks) {
        return;
    }

    window.drawConnectors(
        poseContext,
        results.poseLandmarks,
        window.POSE_CONNECTIONS,
        {
            color: "#63e6be",
            lineWidth: 4
        }
    );

    window.drawLandmarks(
        poseContext,
        results.poseLandmarks,
        {
            color: "#ffffff",
            lineWidth: 1,
            radius: 3
        }
    );
}

function animate() {
    requestAnimationFrame(animate);
    updateAvatarMotion();
    renderer.render(scene, camera);
}

// Естественная расслабленная поза в МИРОВОМ пространстве (для idle / когда часть руки не видна).
// Плечо: вниз и чуть вперёд; предплечье: вниз-вперёд (лёгкий сгиб в локте) — как у стоящего человека.
const RELAXED_UPPER_LEFT = new THREE.Vector3(-0.15, -1, 0.12);
const RELAXED_UPPER_RIGHT = new THREE.Vector3(0.15, -1, 0.12);
const RELAXED_FORE_LEFT = new THREE.Vector3(-0.08, -0.9, 0.35);
const RELAXED_FORE_RIGHT = new THREE.Vector3(0.08, -0.9, 0.35);

function updateAvatarMotion() {
    if (!currentRig) {
        return;
    }

    if (!latestPose) {
        // Лёгкое вращение + руки опущены, пока нет трекинга
        avatarRoot.rotation.y += 0.0015;
        avatarRoot.position.lerp(basePosition, 0.05);
        relaxArms(0.1);
        resetBone(currentRig.head, 0.08);
        resetBone(currentRig.neck, 0.08);
        resetBone(currentRig.spine2, 0.06);
        resetBone(currentRig.spine, 0.05);
        return;
    }

    avatarRoot.rotation.y = smooth(avatarRoot.rotation.y, 0, 0.1);

    const nose = latestPose[0];
    const leftShoulder = latestPose[11];
    const rightShoulder = latestPose[12];
    const leftElbow = latestPose[13];
    const rightElbow = latestPose[14];
    const leftWrist = latestPose[15];
    const rightWrist = latestPose[16];
    const leftHip = latestPose[23];
    const rightHip = latestPose[24];

    const shouldersVisible = isVisible(leftShoulder) && isVisible(rightShoulder);
    const hipsVisible = isVisible(leftHip) && isVisible(rightHip);

    resetBone(currentRig.head, 0.12);
    resetBone(currentRig.neck, 0.12);
    resetBone(currentRig.spine2, 0.06);
    resetBone(currentRig.spine, 0.05);

    let shoulderCenterX = 0.5;
    if (shouldersVisible) {
        shoulderCenterX = (leftShoulder.x + rightShoulder.x) / 2;
        const shoulderCenterY = (leftShoulder.y + rightShoulder.y) / 2;
        const shoulderTilt = leftShoulder.y - rightShoulder.y;

        avatarRoot.position.x = smooth(avatarRoot.position.x, basePosition.x + (shoulderCenterX - 0.5) * MIRROR_X * 1.0, 0.08);
        avatarRoot.position.y = smooth(avatarRoot.position.y, basePosition.y + (0.45 - shoulderCenterY) * 0.6, 0.08);

        rotateBone(currentRig.spine2, {
            z: shoulderTilt * MIRROR_X * 1.4
        }, 0.12);
    }

    if (hipsVisible && shouldersVisible) {
        const hipCenterX = (leftHip.x + rightHip.x) / 2;
        rotateBone(currentRig.spine, {
            y: (shoulderCenterX - hipCenterX) * MIRROR_X * 1.1
        }, 0.08);
    }

    if (isVisible(nose)) {
        // Поворот головы считаем ОТНОСИТЕЛЬНО центра плеч (а не центра кадра),
        // иначе сигнал слишком слабый и голова почти не крутится.
        const headYaw = clamp((nose.x - shoulderCenterX) * MIRROR_X * 3.2, -0.75, 0.75);
        const headPitch = clamp((0.4 - nose.y) * 1.2, -0.5, 0.5);

        rotateBone(currentRig.neck, { y: headYaw * 0.45, x: headPitch * 0.45 }, 0.18);
        rotateBone(currentRig.head, { y: headYaw * 0.55, x: headPitch * 0.55 }, 0.18);
    }

    // Руки: каждый сегмент управляется отдельно. Если предплечье/запястье не видно —
    // рука не дёргается назад, а свисает в естественную расслабленную позу.
    const left = { sh: leftShoulder, el: leftElbow, wr: leftWrist };
    const right = { sh: rightShoulder, el: rightElbow, wr: rightWrist };
    const driveLeftBone = ARM_SWAP ? right : left;
    const driveRightBone = ARM_SWAP ? left : right;

    driveArm(currentRig.leftArm, currentRig.leftForeArm, currentRig.leftHand, driveLeftBone, RELAXED_UPPER_LEFT, RELAXED_FORE_LEFT, 0.25);
    driveArm(currentRig.rightArm, currentRig.rightForeArm, currentRig.rightHand, driveRightBone, RELAXED_UPPER_RIGHT, RELAXED_FORE_RIGHT, 0.25);
}

function driveArm(upper, fore, hand, lm, relaxUpper, relaxFore, amount) {
    if (isVisible(lm.sh) && isVisible(lm.el)) {
        aimBone(upper, fore, limbDir(lm.sh, lm.el), amount);
    } else {
        aimBone(upper, fore, relaxUpper, 0.12);
    }

    if (isVisible(lm.el) && isVisible(lm.wr)) {
        aimBone(fore, hand, limbDir(lm.el, lm.wr), amount);
    } else {
        // предплечье свисает вниз-вперёд от текущего положения локтя
        aimBone(fore, hand, relaxFore, 0.12);
    }
}

function relaxArms(amount) {
    aimBone(currentRig.leftArm, currentRig.leftForeArm, RELAXED_UPPER_LEFT, amount);
    aimBone(currentRig.leftForeArm, currentRig.leftHand, RELAXED_FORE_LEFT, amount);
    aimBone(currentRig.rightArm, currentRig.rightForeArm, RELAXED_UPPER_RIGHT, amount);
    aimBone(currentRig.rightForeArm, currentRig.rightHand, RELAXED_FORE_RIGHT, amount);
}

// Направление сегмента кости в МИРОВОМ пространстве из двух MediaPipe-ландмарок.
// Та же горизонтальная конвенция, что и у корпуса/головы (управляется MIRROR_X),
// чтобы всё зеркалилось согласованно. y экрана (вниз) -> -Y, глубина -> +Z (к камере).
const _limbDir = new THREE.Vector3();
function limbDir(a, b) {
    return _limbDir.set(
        (b.x - a.x) * MIRROR_X,
        -(b.y - a.y),
        -((b.z || 0) - (a.z || 0)) * DEPTH_WEIGHT
    );
}

// Наводит кость так, чтобы её сегмент (bone -> child) смотрел вдоль worldDir.
// Работает для любого рига: rest-направление берётся из реального смещения дочерней кости.
const _parentQuat = new THREE.Quaternion();
const _restDir = new THREE.Vector3();
const _localDir = new THREE.Vector3();
const _targetQuat = new THREE.Quaternion();
function aimBone(bone, child, worldDir, amount) {
    if (!bone || !child || worldDir.lengthSq() < 1e-6) {
        return;
    }

    // rest-направление кости в её локальной системе = направление на дочернюю кость
    _restDir.copy(child.position);
    if (_restDir.lengthSq() < 1e-9) {
        return;
    }
    _restDir.normalize();

    // желаемое направление, переведённое в систему родителя кости
    bone.parent.getWorldQuaternion(_parentQuat);
    _localDir.copy(worldDir).applyQuaternion(_parentQuat.invert()).normalize();

    _targetQuat.setFromUnitVectors(_restDir, _localDir);
    bone.quaternion.slerp(_targetQuat, amount);
}

// Нормализует модель независимо от зашитого в GLB масштаба/смещения:
// масштабирует к единой высоте TARGET_HEIGHT и центрирует на origin avatarRoot.
function fitModel(model, rotationY) {
    model.position.set(0, 0, 0);
    model.scale.setScalar(1);
    model.rotation.y = rotationY || 0;
    model.updateWorldMatrix(true, true);

    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    if (size.y > 0.0001) {
        model.scale.setScalar(TARGET_HEIGHT / size.y);
    }

    model.updateWorldMatrix(true, true);
    const box2 = new THREE.Box3().setFromObject(model);
    const center = box2.getCenter(new THREE.Vector3());

    // сдвигаем так, чтобы центр модели совпал с мировым положением avatarRoot
    model.position.x -= center.x - avatarRoot.position.x;
    model.position.y -= center.y - avatarRoot.position.y;
    model.position.z -= center.z - avatarRoot.position.z;
    model.updateWorldMatrix(true, true);
}

function createRig(model) {
    const bones = [];

    model.traverse(function (object) {
        if (object.isBone) {
            bones.push(object);
            object.userData.restRotation = object.rotation.clone();
        }
    });

    return {
        bones,
        hips: findBone(bones, "Hips"),
        spine: findBone(bones, "Spine"),
        spine1: findBone(bones, "Spine1"),
        spine2: findBone(bones, "Spine2"),
        neck: findBone(bones, "Neck"),
        head: findBone(bones, "Head"),
        leftArm: findBone(bones, "LeftArm"),
        leftForeArm: findBone(bones, "LeftForeArm"),
        leftHand: findBone(bones, "LeftHand"),
        rightArm: findBone(bones, "RightArm"),
        rightForeArm: findBone(bones, "RightForeArm"),
        rightHand: findBone(bones, "RightHand")
    };
}

function findBone(bones, suffix) {
    return bones.find(function (bone) {
        return bone.name === suffix || bone.name.endsWith(`:${suffix}`) || bone.name.endsWith(suffix);
    });
}

function resetBone(bone, amount) {
    if (!bone || !bone.userData.restRotation) {
        return;
    }

    bone.rotation.x = smooth(bone.rotation.x, bone.userData.restRotation.x, amount);
    bone.rotation.y = smooth(bone.rotation.y, bone.userData.restRotation.y, amount);
    bone.rotation.z = smooth(bone.rotation.z, bone.userData.restRotation.z, amount);
}

function rotateBone(bone, rotation, amount) {
    if (!bone || !bone.userData.restRotation) {
        return;
    }

    if (rotation.x !== undefined) {
        bone.rotation.x = smooth(bone.rotation.x, bone.userData.restRotation.x + rotation.x, amount);
    }

    if (rotation.y !== undefined) {
        bone.rotation.y = smooth(bone.rotation.y, bone.userData.restRotation.y + rotation.y, amount);
    }

    if (rotation.z !== undefined) {
        bone.rotation.z = smooth(bone.rotation.z, bone.userData.restRotation.z + rotation.z, amount);
    }
}

function disposeModel(model) {
    model.traverse(function (object) {
        if (object.geometry) {
            object.geometry.dispose();
        }

        if (object.material) {
            const materials = Array.isArray(object.material) ? object.material : [object.material];

            materials.forEach(function (material) {
                Object.keys(material).forEach(function (key) {
                    const value = material[key];

                    if (value && value.isTexture) {
                        value.dispose();
                    }
                });

                material.dispose();
            });
        }
    });
}

function resizeScene() {
    const rect = avatarCanvas.parentElement.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
}

function resizePoseCanvas() {
    const rect = poseCanvas.parentElement.getBoundingClientRect();
    poseCanvas.width = Math.floor(rect.width);
    poseCanvas.height = Math.floor(rect.height);
}

function isVisible(point) {
    return point && point.visibility > 0.45;
}

function smooth(currentValue, targetValue, amount) {
    return currentValue + (targetValue - currentValue) * amount;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
