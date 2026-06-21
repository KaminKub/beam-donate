module.exports = {
  apps: [{
    name: 'tipkub',
    script: 'src/server.js',
    cwd: '/home/tipkub/app',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    // Memory limit — critical for 1GB RAM VPS
    max_memory_restart: '512M',
    node_args: '--max-old-space-size=384',
    // Auto restart on crash
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    // Logging
    error_file: '/home/tipkub/logs/err.log',
    out_file: '/home/tipkub/logs/out.log',
    log_file: '/home/tipkub/logs/combined.log',
    time: true
  }]
};
