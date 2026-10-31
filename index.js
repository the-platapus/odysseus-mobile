import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';

import App from './App';
import { restoreTheme } from './src/theme';

// The splash screen stays up until the saved theme is applied, so a custom theme doesn't
// flash the default one first.
SplashScreen.preventAutoHideAsync();

function Root() {
  const [isThemeReady, setIsThemeReady] = useState(false);

  useEffect(() => {
    restoreTheme()
      .catch(e => console.log(`App Alert: Failed to restore theme: ${e.message}`))
      .finally(() => setIsThemeReady(true));
  }, []);

  useEffect(() => {
    if (isThemeReady) SplashScreen.hideAsync();
  }, [isThemeReady]);

  return isThemeReady ? <App /> : null;
}

const defaultErrorHandler = ErrorUtils.getGlobalHandler();

ErrorUtils.setGlobalHandler((error, isFatal) => {
  const msg = error.message ? error.message : JSON.stringify(error);
  console.log(`App Alert: Unhandled Error: ${msg}`);
  alert(`Unhandled Error: ${msg}`);
  if (defaultErrorHandler) {
    defaultErrorHandler(error, isFatal);
  }
});

const originalConsoleError = console.error;
console.error = (...args) => {
  const msg = args.map(arg => typeof arg === 'object' ? (arg.message || JSON.stringify(arg)) : String(arg)).join(' ');
  console.log(`App Alert: Console Error: ${msg}`);
  alert(`Console Error: ${msg}`);
  originalConsoleError(...args);
};

// registerRootComponent calls AppRegistry.registerComponent('main', () => Root);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(Root);
