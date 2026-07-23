#!/usr/bin/env node
import "dotenv/config";
import { GatewayConfig } from "./config/gateway.js";
import { startServer } from "./server/router.js";

const cfg = new GatewayConfig();
startServer(cfg);
