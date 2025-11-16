import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/**
 * Three.js 渲染器类
 * 负责管理 Three.js 场景、相机、渲染器和网格
 */
export class ThreeRenderer {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private container: HTMLElement;
  private mesh: THREE.Mesh | null = null;
  private animationId: number | null = null;
  private resizeHandler: () => void;

  constructor(container: HTMLElement) {
    this.container = container;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // 创建场景
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1b26);

    // 创建相机
    this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 10000);
    this.camera.position.set(100, 100, 100);
    this.camera.lookAt(0, 0, 0);

    // 创建渲染器
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    // 设置灯光
    this.setupLights();

    // 添加坐标轴辅助
    const axesHelper = new THREE.AxesHelper(50);
    this.scene.add(axesHelper);

    // 设置轨道控制器（鼠标拖动旋转，滚轮缩放）
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; // 启用阻尼效果，使旋转更平滑
    this.controls.dampingFactor = 0.05; // 阻尼系数
    this.controls.enableZoom = true; // 启用缩放
    this.controls.enablePan = true; // 启用平移
    this.controls.minDistance = 10; // 最小缩放距离
    this.controls.maxDistance = 1000; // 最大缩放距离
    this.controls.target.set(0, 0, 0); // 设置旋转中心

    // 处理窗口大小变化
    this.resizeHandler = () => {
      const newWidth = this.container.clientWidth;
      const newHeight = this.container.clientHeight;
      this.camera.aspect = newWidth / newHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(newWidth, newHeight);
    };
    window.addEventListener("resize", this.resizeHandler);

    // 启动动画循环
    this.animate();
  }

  /**
   * 设置场景灯光
   */
  private setupLights(): void {
    // 柔和环境光，保持整体可见
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(ambientLight);

    // 主方向光，增强明暗与高光
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.3);
    directionalLight.position.set(100, 120, 80);
    directionalLight.castShadow = false;
    this.scene.add(directionalLight);

    // 辅助点光源，制造高光与体积感（位于另一侧）
    const pointLight = new THREE.PointLight(0xffffff, 0.9, 0, 2);
    pointLight.position.set(-80, 60, 120);
    this.scene.add(pointLight);
  }

  /**
   * 动画循环
   */
  private animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);

    // 更新控制器（必须在每一帧调用，如果启用了阻尼）
    this.controls.update();

    this.renderer.render(this.scene, this.camera);
  };

  /**
   * 更新网格数据
   * @param positionsData 顶点位置数据 (ArrayBuffer)
   * @param positionsLength 顶点数量
   * @param cellsData 面片索引数据 (ArrayBuffer)
   * @param cellsLength 面片数量
   * @param voxelShape 体素场的维度 [nx, ny, nz]，用于计算旋转中心等信息
   * @param color 网格颜色（十六进制字符串，如 "#7aa2f7"）
   * @returns 渲染构建耗时（毫秒）
   */
  updateMesh(
    positionsData: ArrayBuffer,
    positionsLength: number,
    cellsData: ArrayBuffer,
    cellsLength: number,
    voxelShape: [number, number, number],
    color: string = "#7aa2f7"
  ): number {
    const tStart = performance.now();
    // 验证数据长度（避免潜在错误）
    if (positionsLength <= 0 || cellsLength <= 0) {
      console.warn('警告: 无效的网格数据长度', { positionsLength, cellsLength });
      return 0;
    }
    
    // voxelShape 信息用于记录体素场维度（用于调试和将来的扩展功能）
    void voxelShape; // 标记为已使用
    // 清除旧的网格
    if (this.mesh) {
      this.scene.remove(this.mesh);
      if (this.mesh.geometry) {
        this.mesh.geometry.dispose();
      }
      if (this.mesh.material) {
        if (Array.isArray(this.mesh.material)) {
          this.mesh.material.forEach((mat) => mat.dispose());
        } else {
          this.mesh.material.dispose();
        }
      }
      this.mesh = null;
    }

    // 创建新的几何体
    const geometry = new THREE.BufferGeometry();

    // 使用从 Worker 传输的 ArrayBuffer（零拷贝）
    const flatPositions = new Float32Array(positionsData);
    const flatIndices = new Uint32Array(cellsData);

    geometry.setAttribute("position", new THREE.BufferAttribute(flatPositions, 3));
    geometry.setIndex(new THREE.BufferAttribute(flatIndices, 1));
    geometry.computeVertexNormals();

    // 创建材质（Phong，设置高光与光泽）
    const material = new THREE.MeshPhongMaterial({
      color: new THREE.Color(color),
      specular: new THREE.Color('#ffffff'),
      shininess: 60,
      side: THREE.FrontSide,
      flatShading: false,
    });

    // 创建网格
    const mesh = new THREE.Mesh(geometry, material);

    // 计算中心并居中显示
    geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    if (geometry.boundingBox) {
      geometry.boundingBox.getCenter(center);
      mesh.position.sub(center);

      // 调整相机位置以查看整个模型
      const size = new THREE.Vector3();
      geometry.boundingBox.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      const distance = maxDim * 1.5;
      this.camera.position.set(distance, distance, distance);
    }

    // 设置旋转中心为体素场的中心
    this.controls.target.set(0, 0, 0);
    this.controls.update();

    // 添加到场景
    this.scene.add(mesh);
    this.mesh = mesh;

    return performance.now() - tStart;
  }

  /**
   * 清理资源
   */
  dispose(): void {
    // 停止动画循环
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    // 移除窗口大小变化监听器
    window.removeEventListener("resize", this.resizeHandler);

    // 清理控制器
    if (this.controls) {
      this.controls.dispose();
    }

    // 清理网格
    if (this.mesh) {
      this.scene.remove(this.mesh);
      if (this.mesh.geometry) {
        this.mesh.geometry.dispose();
      }
      if (this.mesh.material) {
        if (Array.isArray(this.mesh.material)) {
          this.mesh.material.forEach((mat) => mat.dispose());
        } else {
          this.mesh.material.dispose();
        }
      }
      this.mesh = null;
    }

    // 清理渲染器
    if (this.renderer) {
      this.container.removeChild(this.renderer.domElement);
      this.renderer.dispose();
    }

    // 清理场景中的所有对象
    while (this.scene.children.length > 0) {
      const object = this.scene.children[0];
      this.scene.remove(object);
      if (object instanceof THREE.Mesh) {
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          if (Array.isArray(object.material)) {
            object.material.forEach((mat) => mat.dispose());
          } else {
            object.material.dispose();
          }
        }
      }
    }
  }

  /**
   * 获取渲染器的 DOM 元素（如果需要直接访问）
   */
  getDomElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }
}
