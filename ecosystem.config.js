module.exports = {
  apps: [
    {
      name: "neron-api",
      cwd: "/opt/neron-server",
      script: "src/index.js",
      env: {
        NODE_OPTIONS: "--dns-result-order=ipv4first",
        HOST: "0.0.0.0",
        PORT: "5000",
      },
    },
  ],
};
