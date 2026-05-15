# Current Routing Implementation

本文记录当前项目中闵行路网和车辆行驶算法的实现基线。对应已提交版本：

```text
faebbc2 Implement strict Minhang OSM topology routing
```

## 数据来源

- 原始数据：`tools/cache/shanghai-260513.osm.pbf`
- 闵行边界：OSM relation `1278189`
- 重建脚本：`tools/rebuild-minhang-topology.mjs`
- 输出文件：
  - `data/app-data.js`
  - `data/route-graph.js`

地图和车辆路由图使用同一批裁切后的 OSM roads，不再出现“视觉底图是一份数据，车辆路由是另一份数据”的错位。

## 拓扑原则

车辆只认 OSM node-ref 拓扑：

- 两条路共享真实 OSM node，才可连通。
- 立交桥、桥、隧道、不同 `layer` 的二维交叉不会自动连通。
- 不生成短 connector。
- 不做 endpoint-to-segment repair。
- 闵行边界裁切点使用 `clip:*` 节点，并在 compact graph 里标记为 `boundaryClip`。

当前重建结果：

```text
roads: 14,002
routableRoads: 13,430
graphNodes: 48,147
directedEdges: 86,616
weakComponents: 238
largestWeakNodes: 46,554
largestWeakRatio: 96.69%
boundaryClipNodes: 419
bridgeEdges: 7,264
tunnelEdges: 312
syntheticEdges: 0
connectorCount: 0
geometryRepairCount: 0
```

2026-05-15 更新后，数据增加了嘉闵走廊附近的边界外补充路段，但已收回北侧范围，避免把虹桥枢纽片区上方不需要的补路带入：

```text
roads: 14,143
routableRoads: 13,568
graphNodes: 48,617
directedEdges: 87,252
weakComponents: 242
largestWeakNodes: 47,032
largestWeakRatio: 96.74%
supplementalRoads: 141
supplementalMinY: 231.93
connectorCount: 0
geometryRepairCount: 0
```

## 车辆选路

车辆每次到达拓扑节点时，只从当前节点的真实出边中选择下一条边。

核心函数：

- `chooseNextTrafficEdge(...)`
- `takePlannedTrafficEdge(...)`
- `findTrafficPath(...)`
- `hasForwardPathAfterEdge(...)`
- `hasImmediateForwardExit(...)`
- `isLegalTrafficTransition(...)`

所有候选边都要通过 `isLegalTrafficTransition(...)`：

- 禁止直接回到上一节点。
- 禁止急回头。
- 高架、桥、隧道、非零 layer 视为立体分离道路。
- 高等级主线不能直接转入低等级地面路。
- 高架/高速下主路必须通过真实 `_link` 匝道。
- 同 roadId 或同等级近似直行可以作为主线延续。

## 死路处理

车辆走到无合法出边节点后，先判断死路类型。

边界死路：

- 节点有 `boundaryClip` 标记。
- 或节点靠近路网边界，且车辆行驶方向朝边界外。
- 正式页表现为驶入/驶离闵行的渐淡效果。

内部死路：

- 不满足边界死路条件。
- 正式页表现为减速停车，然后渐淡消失。

调试页没有正式页完整动画，所以用 `boundaryRespawn` 和 `deadEndRespawn` 计数区分。

## 当前验证

已执行：

```powershell
npm run rebuild:topology
node --check data\app-data.js
node --check data\route-graph.js
node --check js\traffic-graph.js
```

对 `index.html` 与 `traffic-debug.html` 的 inline script 做过语法检查。

转向审计：

```text
rawTransitions: 180,523
legalTransitions: 108,082
blockedUTurn: 69,546
blockedHighToLocal: 702
arrivalStates: 86,333
```

调试页重载后运行一段时间，`掉头/急回头` 计数保持为 `0`。

## 当前新增：随机 OD 与导航式路径

在基线提交之后，首页车辆逻辑开始从“持续巡游 + 临时目标”转向“每辆车一趟随机 OD 行程”：

- 每辆车有 `originKind`、`destinationKind`、`targetNode`、`tripProfile`。
- 起点可能来自区内，也可能来自闵行边界的“区外延申”入口。
- 区外入口主要选择高架、高速、主干路边界节点；少量允许选择较低等级边界路。
- 终点可能是区内目标节点，也可能是边界节点，边界节点代表驶离闵行。
- 到达区外终点时执行快速离区渐淡。
- 到达区内终点时执行减速停车后消失。

路径仍然走 `findTrafficPath(...)`，但路径成本加入了导航偏好：

- 长距离、区外相关、through 策略会偏好高速、高架、主路。
- local 策略更允许使用支路和社区道路。
- `_link` 匝道在高等级路切换时被视为合理上下主路路径。
- 高架/高速路段成本更低，因为不需要频繁停车。

最新实现进一步改成：车辆生成或重生时会先选择 OD，但不再同步做整张图可达性搜索。之前的版本会在每辆车创建和换目标时运行较大的可达目标收集，64 台车同时初始化会阻塞主线程，导致首页明显卡顿。现在车辆先轻量选择随机起点/终点，再按 `nextRoutePlanAt` 错峰触发 A* 路径规划。

路径规划时，随机终点仍保留为车辆的真实目的地；A* 搜索会使用目的地附近的一小组候选拓扑节点，避免严格有向路网中“精确终点节点不可从当前方向进入”导致整条路径失败。若目的地附近候选仍找不到路径，会退回到巡航目标集合，先把车辆带回更可用的路网骨架，再继续后续重规划。

为了避免大量车辆终点和路线过于类似，当前加入了：

- 区外终点概率下调，减少所有车同时冲向少数高等级边界节点。
- 车辆策略分布调整，增加区内 local/arterial 行程占比。
- 目标节点和空间扇区使用衰减惩罚，近期被选过的终点/区域权重会下降。
- 区内起终点只从中等级道路候选中选择，并过滤 `service`、`living_street`、`private`、`driveway`、`parking_aisle`、`drive-through`、rank <= 2 等容易进入内部细碎路网的道路。
- 高架、桥、隧道、高速、trunk 和匝道禁止触发停车消失；车辆必须下到允许停车的地面中等级道路后，才允许执行 park vanish。
- 首页额外保留预制穿越闵行车流：启动时会生成少量 east/south 方向的申嘉湖高速穿越路线，固定车辆沿路线驶入、穿越、驶离，不参与区内停车。穿越车按路线相位分散，不再成批出现在同一个入口；离场后进入错峰等待，再重新驶入。
- 固定穿越车只有在预制路线剩余距离很短、接近路线出口端时才允许驶离淡出，避免还没走到高速离开闵行的端头就提前消失。
- 基础车速统一乘以 `0.72`，整体车辆速度比上一版更慢。

这不是最终完整的都市天际线式交通 AI，但已经把车辆从纯随机局部转向推进到“带目的地、带预规划路径、带路径成本偏好、带起终点类型”的结构。

## 当前新增：起步与驶入/驶离表现

- 区内辅路生成的车辆从 `0` 速度开始，通过 `launch` 速度曲线逐步加速。
- 从边界/其他区块进入的车辆保持巡航速度，不做原地起步。
- 离开闵行的车辆不再驶出很远才消失；现在在靠近 `boundaryClip` 后更早触发，并在较短距离内快速淡出。

## 当前新增：首页矢量缩放

首页 `index.html` 增加了地图缩放控制：

- 鼠标滚轮缩放。
- 拖拽平移。
- `+` / `-` / `1:1` 控制按钮。
- 最大缩放倍率为 `800%`。

首页地图目前已经使用新版严格 OSM 数据，不需要再换一份底图。为了避免放大后变成图片像素化，首页把道路、片区等静态层按当前视图重新矢量绘制进缓存；缩放、拖拽或链卡高亮变化时会标记缓存失效并重绘。车辆、迁移线和标签仍在动态层按当前视图绘制。

放大后的道路线宽不再和地图 1:1 等比膨胀，而是进入细线细节模式：

- 高速、主干道、辅路都按屏幕像素控制线宽，放大后能看清更细的转向和匝道走向。
- 桥、高架、隧道、非零 layer、`*_link` 匝道有独立细线高亮。
- 车辆尺寸也不再和地图 1:1 缩放，初始状态更小，放大后只缓慢变大，避免遮住路网细节。
