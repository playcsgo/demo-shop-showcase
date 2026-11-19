import { createApp } from './app.js';

const app = await createApp(process.env);
app.enableShutdownHooks();
await app.listen(process.env.PORT ?? 3000);
