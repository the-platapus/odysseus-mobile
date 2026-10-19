#!/bin/bash
echo "Waiting for eas build to finish..."
while pgrep -f "eas build" > /dev/null; do
  sleep 10
done
echo "Build finished! Converting AAB to APK..."
LATEST_AAB=$(ls -t *.aab | head -n 1)
if [ -n "$LATEST_AAB" ]; then
  wget -q https://github.com/google/bundletool/releases/download/1.15.6/bundletool-all-1.15.6.jar -O bundletool.jar
  java -jar bundletool.jar build-apks --bundle="$LATEST_AAB" --output=app.apks --mode=universal
  unzip -p app.apks universal.apk > app-universal.apk
  /home/abdul/Android/Sdk/build-tools/35.0.0/apksigner sign --ks debug.keystore --ks-pass pass:android app-universal.apk
  rm bundletool.jar app.apks
  echo "Done converting and signing! APK is ready."
else
  echo "No AAB file found."
fi
