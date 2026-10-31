// Dynamic config layered on top of app.json. Expo reads app.json first and passes it in as
// `config`; nothing in it is changed here. This file exists because app.json can't hold
// comments, and the Android ABI limit below needs explaining, and because which release a
// GitHub Actions build becomes is only known while it builds.
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

// The GitHub release a build made by .github/workflows/mobile-build.yml is published as, so the
// app can tell when a newer one is out (src/update/). Same tag the workflow's release job picks:
// the pushed tag, else the prerelease "build-<run number>". app.json's version is the same for
// every build from master, so the run number is what orders them. The app reads this as
// Constants.expoConfig.extra.release; local, EAS and development builds don't have it.
// (android.versionCode stays 1: a higher one would stop local builds installing over these.)
const env = process.env;
const ciRelease =
  env.GITHUB_ACTIONS === 'true' && env.GITHUB_RUN_NUMBER
    ? {
        tag: env.GITHUB_REF_TYPE === 'tag' ? env.GITHUB_REF_NAME : `build-${env.GITHUB_RUN_NUMBER}`,
        runNumber: Number(env.GITHUB_RUN_NUMBER),
        commit: env.GITHUB_SHA,
        prerelease: env.GITHUB_REF_TYPE !== 'tag',
      }
    : null;

module.exports = ({ config }) => ({
  ...config,
  extra: { ...config.extra, ...(ciRelease && { release: ciRelease }) },
  plugins: [...(config.plugins ?? []), withAndroidAbis],
});
