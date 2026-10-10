import { registerRootComponent } from 'expo';

import App from './App';

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

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
