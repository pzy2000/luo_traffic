# 2026-05-15 Routing Update

本文件记录本轮车辆行驶算法和嘉闵补路裁剪的更新。

## 数据裁剪

补路脚本仍然使用 `tools/cache/shanghai-260513.osm.pbf`，并坚持 strict OSM node-ref topology：

- 不做几何吸附。
- 不做 endpoint-to-segment repair。
- 不生成跨层、跨桥、跨隧道的伪连接。
- 只有真实共享 OSM node 的道路才连通。

本轮把北侧区外嘉闵补路继续向南收紧：

```text
SUPPLEMENTAL_NORTH_TRIM_DEGREES = 0.032
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

这会去掉虹桥枢纽片区上方那块额外补入的嘉闵高架路，同时保留更靠南、对闵行路网完整性有帮助的边界外补充段。

## 起终点选择

车辆区内生成点和区内消失点不再放在最低等级道路上，而是优先放在中等级道路：

- 允许：`unclassified`、`tertiary`、`secondary`。
- 排除：`service`、`living_street`、停车场通道、私有道路、`rank <= 2` 的细节内部路。
- 区内 OD 会优先选择不同片区/不同 district 的目标；如果可选点足够多，同片区目标会被明显降权。
- 区内生成仍然从 0 速度起步，区外/边界进入车辆保持巡航速度。

相关函数：

- `isLocalTripEndpointEdge(...)`
- `isInternalDetailRoadEdge(...)`
- `collectLocalEndpointNodes(...)`
- `collectLocalSpawnEdges(...)`
- `selectInsideTripEndpoint(...)`
- `chooseWeightedTripNode(...)`

## 主路优先路径

在 A* 前新增了 `planGreedyMainRoadRoute(...)`，用于快速生成一段“像导航”的主路优先路径：

1. 从中等级起点道路贪心接入 rank >= 6 的主路或真实匝道。
2. 上主路后尽量保持在 `primary`、`trunk`、`motorway`、高架、桥、同 `roadId` 主线上。
3. 接近目的地后才允许降级到中等级道路，模拟从最近出口下主路再去终点。
4. 贪心路线只是一段前导路线；如果它没有直接抵达目标附近，后续继续由 `findTrafficPath(...)` 按真实拓扑兜底。

A* 也同步避开细节内部路：

- `findTrafficPath(...)` 扩展候选时跳过内部细节路。
- `navigationRoadCostMultiplier(...)` 对内部细节路加高成本。
- `chooseNextTrafficEdge(...)` 的兜底候选会优先过滤内部细节路。

这样车辆仍严格遵守新底图的拓扑连通性，高架车不会在平面交叉口突然转弯；只有存在真实匝道、真实共享节点和合法转向时才会下主路。

## 2026-05-15 追加：高架禁停与穿越流量

本轮继续修正车辆表现：

- `startParkVanish(...)` 增加硬门禁，只有 `canStopOrParkOnEdge(...)` 允许的道路才能停车消失。
- 高架、桥、隧道、高速、trunk、匝道都不能触发 park vanish；车辆必须继续行驶到地面中等级道路后才能停车消失。
- 到达区内目标时，如果当前仍在高架/高速/匝道上，不再原地消失，而是进入 retire intent，继续找可停车的地面道路。
- 内部死路也不再无条件停车消失；不满足停车条件时只会请求继续寻找可停车路段。
- 基础车速统一乘以 `VEHICLE_SPEED_SCALE = 0.72`，整体更慢。

新增预制穿越闵行流量：

- `collectPresetThroughRoutes(...)` 会在启动时从边界高等级道路里追踪少量固定穿越路线。
- 当前可生成 2 条申嘉湖高速方向的穿越路线，分别覆盖 east -> south 和 south -> east。
- `PRESET_THROUGH_VEHICLE_INTERVAL = 4`，64 台车里约 8 台固定作为穿越车播放这些路线。
- 这类车的 `originKind` 和 `destinationKind` 都是 `outside`，只做驶入/驶离，不参与区内停车。

随后又修正了两个穿越车问题：

- 固定穿越车不再从同一个起点成批出现；初始化时按路线长度分散到不同相位，离场后进入不可见等待期，再按每辆车自己的序号和随机抖动重新驶入。
- 固定穿越车不再使用普通 through 车的宽松边界淡出规则；只有预制路线剩余距离很短、接近路线出口端时，才允许触发驶离闵行动画。

## 验证

本轮没有启动浏览器，按用户要求交给人工视觉验证。已完成的本地验证：

```powershell
npm run precompute:graph
node --check tools/rebuild-minhang-topology.mjs
node --check data\app-data.js
node --check data\route-graph.js
```

另外提取 `index.html` 的 inline script 用 `new Function(...)` 做了语法检查，结果通过。
