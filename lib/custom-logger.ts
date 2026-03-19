const fs = require('fs');
const path = require('path');

const logDir = path.join(process.cwd(), 'logs');
const logFile = path.join(logDir, 'game.log');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

function writeLog(message) {
  if (process.env.NODE_ENV === 'production') return;
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(logFile, logMessage);
  console.log(message);
}

module.exports = { writeLog };
