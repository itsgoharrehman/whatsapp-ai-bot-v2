import { startServer } from './server.js';
import { sessionManager } from './bot.js';

startServer();
sessionManager.restoreSessions();
