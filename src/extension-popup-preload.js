// Preload for extension popup windows
// Prevents chrome object from being frozen so extensions can add properties to it

const origFreeze = Object.freeze;
const origSeal = Object.seal;
const origPreventExtensions = Object.preventExtensions;

// Intercept freeze/seal on the chrome object specifically
Object.freeze = function(obj) {
  if (obj && typeof obj === 'object' && obj === globalThis.chrome) return obj;
  return origFreeze.call(this, obj);
};
Object.seal = function(obj) {
  if (obj && typeof obj === 'object' && obj === globalThis.chrome) return obj;
  return origSeal.call(this, obj);
};
Object.preventExtensions = function(obj) {
  if (obj && typeof obj === 'object' && obj === globalThis.chrome) return obj;
  return origPreventExtensions.call(this, obj);
};
