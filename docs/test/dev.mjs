/* Local dev server: npm start, then open http://localhost:8099 */
import { serve } from './serve.mjs';

await serve(8099);
console.log('Shelfie running at http://localhost:8099');
console.log('(The camera needs https or localhost — localhost counts, so scanning works here.)');
