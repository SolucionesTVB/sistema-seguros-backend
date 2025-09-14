{
  "name": "sistema-seguros-backend",
  "version": "1.0.0",
  "description": "Backend para sistema de comparación de seguros de autos",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "multer": "^1.4.5",
    "pg": "^8.11.3",
    "pdfjs-dist": "^3.11.174"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "keywords": ["seguros", "pdf", "comparacion", "cotizaciones"],
  "author": "Tu nombre",
  "license": "MIT"
}