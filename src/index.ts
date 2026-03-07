import dotenv from "dotenv";
import { app } from "./app.js";

dotenv.config();

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log("Endpoints:");
  console.log("  GET  /health");
  console.log("  GET  /signer");
  console.log("  POST /sign");
  console.log("  GET  /swap/quote");
  console.log("  POST /swap/build");
  console.log("  POST /topup-idrx");
});
