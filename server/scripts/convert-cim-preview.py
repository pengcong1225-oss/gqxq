"""Prepare an approved B4 coordinate-conversion input using a strict PROJ operation."""

import argparse
import hashlib
import json
from pathlib import Path
import sys

from pyproj.aoi import AreaOfInterest
from pyproj.transformer import TransformerGroup


def convert(preview_path: Path, output_path: Path) -> None:
    repo = Path(__file__).resolve().parents[2]
    if preview_path.resolve().is_relative_to(repo) or output_path.resolve().is_relative_to(repo):
        raise ValueError("CIM 几何文件须保存在 Git 仓库外")
    source_bytes = preview_path.read_bytes()
    preview = json.loads(source_bytes)
    if preview.get("type") != "FeatureCollection" or preview.get("metadata", {}).get("srid") != 4490:
        raise ValueError("须提供准备脚本生成的 EPSG:4490 源预览")
    features = preview.get("features")
    if not features:
        raise ValueError("源预览没有要素")

    group = TransformerGroup(
        4490, 4326, always_xy=True, allow_ballpark=False,
        area_of_interest=AreaOfInterest(110.2, 29.9, 112.15, 31.62),
    )
    if not group.best_available or not group.transformers or group.transformers[0].accuracy < 0:
        raise ValueError("PROJ 在宜昌范围无已知精度的 4490→4326 操作，无法生成正式边界转换文件")
    operation = group.transformers[0]

    def polygon(rings):
        return [[operation.transform(x, y, errcheck=True) for x, y in ring] for ring in rings]

    for feature in features:
        geometry = feature["geometry"]
        if geometry["type"] == "Polygon":
            geometry["coordinates"] = polygon(geometry["coordinates"])
        elif geometry["type"] == "MultiPolygon":
            geometry["coordinates"] = [polygon(poly) for poly in geometry["coordinates"]]
        else:
            raise ValueError("源预览包含不受支持的几何类型")

    preview["metadata"].update({
        "srid": 4326,
        "sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
        "operation": operation.description,
        "accuracyMeters": operation.accuracy,
    })
    result = json.dumps(preview, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    try:
        with output_path.open("x", encoding="utf-8") as output:
            output.write(result)
    except FileExistsError:
        if output_path.read_text(encoding="utf-8") != result:
            raise ValueError("输出文件已存在其他批次，请使用新路径") from None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preview", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        convert(args.preview, args.output)
    except (OSError, ValueError, KeyError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
