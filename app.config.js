// Dynamic config layered on top of app.json. Expo reads app.json first and passes it in as
// `config`; nothing in it is changed here. This file exists only because app.json can't hold
// comments, and the Android ABI limit below needs explaining.
const { withGradleProperties } = require('expo/config-plugins');

// MODIFIED: build Android native code for arm64-v8a (phones) and x86_64 (emulators) only.
// Reason: the generated android/gradle.properties defaults to all four ABIs (armeabi-v7a,
// arm64-v8a, x86, x86_64). llama.rn doesn't support the two 32-bit ones, so compiling every
// other native module for them only costs build time and APK size for devices the app can't
// run on anyway. Applies wherever android/ is generated: EAS cloud, `eas build --local`,
// `expo run:android` and the GitHub workflow.
const ANDROID_ABIS = ['arm64-v8a', 'x86_64'];

const withAndroidAbis = (config) =>
  withGradleProperties(config, (config) => {
    config.modResults = config.modResults.filter(
      (item) => !(item.type === 'property' && item.key === 'reactNativeArchitectures')
    );
    config.modResults.push({
      type: 'property',
      key: 'reactNativeArchitectures',
      value: ANDROID_ABIS.join(','),
    });
    return config;
  });

module.exports = ({ config }) => ({
  ...config,
  plugins: [...(config.plugins ?? []), withAndroidAbis],
});
