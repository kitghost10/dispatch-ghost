import { MemoryStore } from "../src";
import { storeContract } from "./store.contract";

storeContract("memory", async () => new MemoryStore());
