# OSM 路网拓扑质量实现记录

本文档记录本轮高质量路网实现的核心原则、诊断 demo、前端检查页面，以及项目内闵行路网重建方案。

## 核心原则

车辆可行驶路网必须按 OSM 拓扑构建，而不是按屏幕上的线段相交关系构建。

- 真正连通：两个道路段共享同一个 OSM node id。
- 不应连通：桥梁、隧道、高架、不同 `layer` 的二维投影交叉。
- 立交桥：匝道和主线只有在 OSM 数据中共享节点时才可转向。
- 裁切边界：闵行边界外道路需要裁掉，但原始 OSM node id 必须尽量保留。
- 几何修补：默认关闭，不再自动把附近端点、附近线段吸附到一起。

这和常见路由引擎的做法一致：OSRM、SUMO `netconvert`、osm2pgrouting 等都会从 OSM ways 的 node refs 建路由拓扑，而不会把不同层级的二维交叉直接当路口。

## 上海全网诊断 Demo

演示目录在外层工作区：

```text
E:\1.study\code\BlockChain\luo_traffic\osm_topology_demo
```

主要文件：

- `build_road_graph.py`：从 `shanghai-260513.osm.pbf` 读取 OSM ways/nodes，按 OSM node refs 建图。
- `audit_crossings.py`：找二维几何相交但不共享 OSM node 的位置，用于识别高架/桥梁/隧道等不应连通场景。
- `make_whole_network_vectors.py`：生成完整上海路网矢量段数据。
- `whole_network_viewer.html`：前端矢量拓扑检查页面。
- `topology_viewer.html`：小样例解释页面，用于对比共享节点、立交交叉、错误平面连通。

上海全网构图结果：

- OSM car profile ways：`167,714`
- 节点：`640,902`
- 有向边：`1,203,566`
- 弱连通分量：`492`
- 最大弱连通分量：`629,512` nodes，覆盖 `98.22%`
- 最大强连通分量：`625,795` nodes，覆盖 `97.64%`

全网页面：

```text
http://127.0.0.1:8766/whole_network_viewer.html
```

重点图层：

```text
http://127.0.0.1:8766/whole_network_viewer.html?layer=high
http://127.0.0.1:8766/whole_network_viewer.html?layer=interchange
```

## 前端检查页面能力

`whole_network_viewer.html` 已从 PNG 概览图改成 canvas 矢量渲染。

- 全网组件：绿色为最大弱连通分量，橙/蓝/红为非主分量。
- 主连通块：只显示最大弱连通分量。
- 非主分量：突出显示未进入主网的分量，右侧可点击定位。
- 高等级道路：高速/快速、主干/次干、匝道 link 分色。
- 立交/桥隧：`*_link`、`bridge/layer`、`tunnel` 分色。
- 缩放：最大 `4000%`。
- 线宽：所有拓扑检查层使用发丝线，放大后仍保持细线，便于人工检查连通性。
- 标记：可关闭非主分量圆点，避免遮挡局部路线。

线条看起来弯折的原因：OSM 道路中心线本身是 polyline，真实道路曲线由多个节点折线近似表达。早期 demo 还存在内部投影网格量化，后来矢量坐标提升到 `14400 x 12000`，剩余折线主要来自 OSM 原始几何。

## 旧项目实现问题

当前项目旧链路的问题集中在“数据源、视觉几何、路由拓扑不完全一致”：

- `tools/rebuild-gdal-data.mjs` 使用 GDAL/OGR 输出道路几何，视觉裁切效果可以，但 GeoJSON 输出没有 OSM node refs，无法直接表达真实拓扑。
- `tools/precompute-osm-route-graph.mjs` 另行从 PBF 生成路由图，导致视觉道路和车辆路由图不是同一份道路对象。
- `js/traffic-graph.js` 默认曾开启 `connectors`，会把附近端点用短线连接起来。
- `precompute-osm-route-graph.mjs` 的 `balanced` profile 会生成大量 `short-extension`、`short-junction` 和少量 `repair-connector`。
- 当前 `data/route-graph.js` 里已有 `7,442` 个 connector 和 `78` 个 endpoint-to-segment repair，这些合成边会在复杂立交、平行车道、上下层道路附近带来误连风险。
- 旧 compact graph 没有持久化 edge 的 `bridge/tunnel` 标记，浏览器 hydrate 后高架/隧道语义会丢失一部分。

因此本轮不继续在旧数据上修补，而是新增一条严格拓扑重建管线。

## 新闵行重建管线

新增脚本：

```text
tools/rebuild-minhang-topology.mjs
```

新增 npm 命令：

```powershell
npm run rebuild:topology
npm run precompute:graph
```

默认输入：

```text
tools/cache/shanghai-260513.osm.pbf
```

输出：

- `data/app-data.js`
- `data/route-graph.js`

脚本职责：

1. 从 PBF 读取闵行 relation `1278189` 的边界 ways。
2. 重建闵行外环 polygon。
3. 读取全部车行相关 highway ways。
4. 将每条 OSM segment 精确裁切到闵行 polygon。
5. 裁切后仍保留原始 OSM node id；只有边界切点使用 `clip:*` 合成节点。
6. 视觉道路 `appData.roads` 和车辆路由 `TRAFFIC_ROUTE_GRAPH` 使用同一批 roads。
7. 用 `TrafficGraph.buildRoadGraph(..., { connectors:false, geometryRepairs:false })` 构图。
8. `route-graph.js` 使用 `compact-v2`，保留 edge 的 `bridge/tunnel` flags。

## 预期诊断指标

高质量路网不追求“所有二维线段全部联通”，而追求“不该连的不连、该连的共享 OSM node 后自然连”。

需要重点看：

- `connectorCount` 必须为 `0`。
- `geometryRepairCount` 必须为 `0`。
- 高等级道路是否进入最大弱连通分量。
- 立交/桥隧附近是否只有真实 OSM node 连接。
- 车辆是否沿真实边行驶，不再通过短 connector 抖动、跳线、乱转。

## 本次闵行重建结果

命令：

```powershell
npm run rebuild:topology
```

结果：

- 数据源：`tools/cache/shanghai-260513.osm.pbf`
- 闵行边界 relation：`1278189`
- 边界外环点数：`2,025`
- 上海 PBF highway ways 输入：`173,236`
- 闵行裁切后道路片段：`14,002`
- 命名道路片段：`6,886`
- 可路由道路片段：`13,430`
- 所有道路片段均带 `nodeIds`：`14,002 / 14,002`
- 路由图格式：`compact-v2`
- 路由拓扑：`strict-osm-node-refs`
- 图节点：`48,147`
- 图有向边：`86,616`
- 弱连通分量：`238`
- 最大弱连通分量：`46,554` nodes
- 最大弱连通覆盖：`96.69%`
- synthetic edge rows：`0`
- connectorCount：`0`
- geometryRepairCount：`0`
- bridge edge flags：`7,264`
- tunnel edge flags：`312`

这组数字说明：在不做几何吸附、不做 endpoint-to-segment repair 的情况下，闵行主体车行路网已经自然进入一个高覆盖主连通块。后续车辆仿真应基于这个严格图运行，而不是旧的 GDAL 视觉几何加短 connector 修补图。

## 本轮项目改动

- 新增 `tools/rebuild-minhang-topology.mjs`。
- 新增 `npm run rebuild:topology`。
- 将 `npm run precompute:graph` 指向严格拓扑重建脚本。
- 保留旧脚本为 `npm run precompute:graph:legacy`，便于回看旧结果。
- 更新 `data/app-data.js`，视觉道路改为严格 OSM node-ref 裁切结果。
- 更新 `data/route-graph.js`，路由图改为 `compact-v2 / strict-osm-node-refs`。
- 更新 `js/traffic-graph.js`，默认关闭 connector，并支持 hydrate `compact-v2` 的 `bridge/tunnel` flags。
- 更新 `index.html` 与 `traffic-debug.html` 的 fallback 构图逻辑，默认不再生成短 connector。
- 更新 `traffic-debug-fast.html` 的数据源显示，明确展示 `Strict OSM`。

## 车辆行驶算法约束

这轮继续把车辆运行逻辑收紧到新的严格拓扑图上，目标是车辆只能沿 `TRAFFIC_ROUTE_GRAPH` 的真实有向边移动，不能因为二维线段靠得近、视觉上交叉、或旧 connector 修补而跳线。

### 图数据新增语义

- `tools/rebuild-minhang-topology.mjs` 在 `compact-v2` 的 node 数组第 6 位写入 node flags。
- `clip:*` 裁切节点会被标记为 `boundaryClip`，用于区分“闵行边界裁切死路”和“区内真实死路”。
- `js/traffic-graph.js` hydrate 后会恢复 `node.boundaryClip`。
- `compact-v2` edge flags 继续恢复 `edge.bridge` / `edge.tunnel`，车辆算法可以识别桥、高架、隧道、layer 与 link。

当前重建后的关键字段抽样：

```text
nodes: 48,147
directedEdges: 86,616
boundaryClipNodes: 419
bridgeEdges: 7,264
tunnelEdges: 312
syntheticEdges: 0
connectorCount: 0
geometryRepairCount: 0
```

### 合法转向规则

正式页 `index.html` 和诊断页 `traffic-debug.html` 共用同一类判断规则：

- 车辆到达节点后，所有候选下一边都必须先通过 `isLegalTrafficTransition(...)`。
- 禁止直接返回上一节点。
- 禁止急回头：相邻边方向夹角过大时直接判为非法，避免车辆在路口硬拐回头。
- 桥、高架、隧道、非零 `layer` 被视为立体分离道路。
- 立体分离主线改变层级时，除非是同路名/同 roadId 的近似直行延续，或者下一条是 `_link` 匝道，否则禁止转向。
- 高等级道路主线不能直接转到低等级地面路；必须先走 `motorway_link` / `trunk_link` / `primary_link` 等真实匝道。
- 路径规划 `findTrafficPath(...)`、计划路线执行 `takePlannedTrafficEdge(...)`、前方可达性 `hasForwardPathAfterEdge(...)` / `hasImmediateForwardExit(...)` 都接入同一套合法转向判断。

这样做后，高架上的车不会因为节点坐标接近或视觉交叉突然转到地面路；只有 OSM 拓扑中真实共享节点且符合桥隧/layer/link 语义的出口才会被选择。

### 死路分类与车辆消失

正式页新增 `isBoundaryDeadEndNode(...)`：

- 优先判断 `node.boundaryClip`，这是最可靠的闵行区裁切边界。
- 对旧/兜底数据，继续用 `roadBounds` 附近节点和车辆行驶方向是否朝外作为边界判断。
- 如果车辆到达边界死路，走 `startExitVanish(..., "dead-end-boundary")`，表现为驶入/驶离闵行。
- 如果车辆到达区内死路，走 `startParkVanish(..., "dead-end-interior")`，表现为减速停车后消失。

诊断页没有正式页的完整消失动画，因此同步了分类逻辑：边界死路计入 `boundaryRespawn`，区内死路计入 `deadEndRespawn`，用于观察算法行为。

### 转向审计结果

对全图有向边做一次候选转向审计，结果如下：

```text
rawTransitions: 180,523
legalTransitions: 108,082
blockedUTurn: 69,546
blockedHighToLocal: 702
arrivalStates: 86,333
noLegalBoundaryClip: 141
noLegalNearBoundary: 139
noLegalInternal: 4,566
```

说明：

- `blockedUTurn` 包含大量双向路的反向边，这些现在不会再被车辆当作下一步直接选择。
- `blockedHighToLocal` 是被拦下的高等级/立交主线直接转低等级非匝道候选。
- `noLegalBoundaryClip` 和 `noLegalNearBoundary` 会走驶入/驶离闵行效果。
- `noLegalInternal` 会走区内死路停车消失效果。

### 验证

执行过的检查：

```powershell
npm run rebuild:topology
node --check data\app-data.js
node --check data\route-graph.js
node --check js\traffic-graph.js
```

并对 `index.html`、`traffic-debug.html` 的 inline script 做了 `new Function(...)` 语法检查。

页面验证：

- `http://127.0.0.1:5500/index.html?v=strict-driving-final` 可以正常渲染正式页，车辆和跨链状态持续刷新。
- `http://127.0.0.1:5500/traffic-debug.html?v=strict-driving` 可以正常渲染诊断页。
- 调试页重载后运行一段时间，`掉头/急回头` 计数保持为 `0`，说明新的急回头拦截已经生效。
