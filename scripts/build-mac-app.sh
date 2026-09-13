#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/mac-agent"
DERIVED="$PROJECT/DerivedData"
PACKAGES="$PROJECT/SourcePackages"
OUTPUT="$ROOT/outputs"

cd "$PROJECT"
xcodegen generate
xcodebuild -resolvePackageDependencies -project YaokongtaiAgent.xcodeproj -scheme YaokongtaiAgent \
  -derivedDataPath "$DERIVED" -clonedSourcePackagesDirPath "$PACKAGES"
xcodebuild test -project YaokongtaiAgent.xcodeproj -scheme YaokongtaiAgent -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED" -clonedSourcePackagesDirPath "$PACKAGES" CODE_SIGNING_ALLOWED=NO
xcodebuild build -project YaokongtaiAgent.xcodeproj -scheme YaokongtaiAgent -configuration Release -destination 'platform=macOS' \
  -derivedDataPath "$DERIVED" -clonedSourcePackagesDirPath "$PACKAGES" CODE_SIGNING_ALLOWED=NO

mkdir -p "$OUTPUT"
rm -rf "$OUTPUT/遥控台代理.app"
cp -R "$DERIVED/Build/Products/Release/YaokongtaiAgent.app" "$OUTPUT/遥控台代理.app"
SIGNING_IDENTITY="${YAOKONGTAI_SIGNING_IDENTITY:-Apple Development}"
codesign --force --deep --options runtime --sign "$SIGNING_IDENTITY" "$OUTPUT/遥控台代理.app"
codesign --verify --deep --strict --verbose=2 "$OUTPUT/遥控台代理.app"
echo "Built and verified: $OUTPUT/遥控台代理.app"
