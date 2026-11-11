# grid_boundary / b4-v1

- 文件：UTF-8 `.geojson`，顶层为 FeatureCollection，templateVersion 固定 `b4-v1`。
- 每个 Feature 表示一条现有行政网格的边界；properties.code 是稳定行政网格编码（文本、保留前导零），不能用上传几何创建未知网格。
- properties.coordinateSystem：固定 `WGS84`，二维经度、纬度顺序；经度 [-180,180]、纬度 [-90,90]。
- properties.geometrySource：必填真实权威来源说明，最多 500 字；样例全部虚构，导入前替换。
- properties.conversion：固定 `none`。平台不自动转换；其他坐标系须先在受控流程中转换为 WGS84，并在来源说明记录转换依据。
- geometry：Polygon 或 MultiPolygon；环须闭合、无重复零长边、无自交、面积非零；孔洞须在外环内，多面不得相交或重叠。
- 限额：10 MiB、最多 2000 个 Feature、总顶点最多 20000（闭合终点计入）；仍受 B3 单环和多面限额约束。
- 导入：grid.manage + masterdata.import，并具备每个现有行政网格的当前区划范围；全批预览校验后原子提交。
- 历史：更新行政边界不重写已发布服务网格覆盖快照；需要采用新边界时通过正常新覆盖有效期建立版本。
