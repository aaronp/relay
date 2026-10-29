import { startDevIssuer } from './issuer';

const port = Number(process.env.PORT ?? 7864);
const iss = await startDevIssuer({ port });
console.log(`dev issuer at ${iss.issuer}  (mint: ${iss.issuer}/mint?sub=alice&saids=A,B&ttl=3600)`);
