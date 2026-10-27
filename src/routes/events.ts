import { Router } from 'express';
import { bus } from '../lib/logger.ts';

export const eventsRouter = Router();

eventsRouter.get('/', (req, res) => {
  bus.subscribe(req, res);
});
