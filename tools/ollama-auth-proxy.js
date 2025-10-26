#!/usr/bin/env node

// Ollama Auth Proxy
// Simple Express proxy that adds API key authentication in front of Ollama
//
// Usage:
//   node ollama-auth-proxy.js
//
// Environment variables:
//   OLLAMA_API_KEY - The API key to require (get from AWS Parameter Store)
//   OLLAMA_PORT - Port to listen on (default: 11435)
//   OLLAMA_TARGET - Ollama endpoint to proxy to (default: http://localhost:11434)
//   SSL_KEY_PATH - Path to SSL private key file (required for HTTPS)
//   SSL_CERT_PATH - Path to SSL certificate file (required for HTTPS)

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');

const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
const PORT = parseInt(process.env.OLLAMA_PORT || '11435');
const OLLAMA_TARGET = process.env.OLLAMA_TARGET || 'http://localhost:11434';
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;

if (!OLLAMA_API_KEY) {
  console.error('ERROR: OLLAMA_API_KEY environment variable is required');
  process.exit(1);
}

if (SSL_KEY_PATH && !SSL_CERT_PATH || !SSL_KEY_PATH && SSL_CERT_PATH) {
  console.error('ERROR: Both SSL_KEY_PATH and SSL_CERT_PATH must be provided for HTTPS');
  process.exit(1);
}

const app = express();

// Parse JSON body
app.use(express.json({ limit: '10mb' }));

// Auth middleware
function checkApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing X-API-Key header' });
  }

  if (apiKey !== OLLAMA_API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}

// Proxy all requests to Ollama
app.use(checkApiKey, (req, res) => {
  const targetUrl = new URL(req.url, OLLAMA_TARGET);

  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} -> ${targetUrl.href}`);

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || 11434,
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: {
      ...req.headers,
      host: targetUrl.hostname
    }
  };

  // Remove auth header before proxying
  delete options.headers['x-api-key'];

  const proxyReq = http.request(options, (proxyRes) => {
    res.statusCode = proxyRes.statusCode;

    // Copy headers
    Object.keys(proxyRes.headers).forEach(key => {
      res.setHeader(key, proxyRes.headers[key]);
    });

    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err);
    res.status(502).json({ error: 'Bad Gateway', details: err.message });
  });

  // Forward request body
  if (req.body && Object.keys(req.body).length > 0) {
    const bodyData = JSON.stringify(req.body);
    proxyReq.setHeader('Content-Type', 'application/json');
    proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
    proxyReq.write(bodyData);
  }

  proxyReq.end();
});

// Create HTTP or HTTPS server based on SSL configuration
if (SSL_KEY_PATH && SSL_CERT_PATH) {
  const httpsOptions = {
    key: fs.readFileSync(SSL_KEY_PATH),
    cert: fs.readFileSync(SSL_CERT_PATH)
  };

  https.createServer(httpsOptions, app).listen(PORT, '0.0.0.0', () => {
    console.log(`🔒 Ollama auth proxy (HTTPS) listening on 0.0.0.0:${PORT}`);
    console.log(`Proxying to: ${OLLAMA_TARGET}`);
    console.log(`API key configured: ${OLLAMA_API_KEY.substring(0, 8)}...`);
    console.log(`SSL cert: ${SSL_CERT_PATH}`);
  });
} else {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`⚠️  Ollama auth proxy (HTTP) listening on 0.0.0.0:${PORT}`);
    console.log(`Proxying to: ${OLLAMA_TARGET}`);
    console.log(`API key configured: ${OLLAMA_API_KEY.substring(0, 8)}...`);
    console.log(`WARNING: Running without SSL - use SSL_KEY_PATH and SSL_CERT_PATH for HTTPS`);
  });
}
