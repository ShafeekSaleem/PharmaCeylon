// Jest stand-in for a CSS module: every class name maps to itself.
module.exports = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === "__esModule"
        ? false
        : key === "default"
          ? module.exports
          : String(key),
  },
);
