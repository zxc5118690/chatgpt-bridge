#!/usr/bin/env node
import { main } from '../src/send-only/cli.js';

process.exitCode = await main();
