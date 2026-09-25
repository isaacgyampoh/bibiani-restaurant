import { getRequestListener } from '@hono/node-server';
import { compose } from './composition';

// Serverless entry (Vercel Functions, Node runtime): a standard Node (req, res) handler.
// One composed app (and one small database pool) per warm instance.
const { http } = compose();
export default getRequestListener(http.fetch);
