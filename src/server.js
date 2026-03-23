require("dotenv").config();

const { initDb } = require("./lib/db");
const { createApp } = require("./app");

async function startServer() {
    const db = await initDb();
    const app = createApp(db);
    const port = Number(process.env.PORT || 3001);

    app.listen(port, () => {
        console.log(`MechHub miniback listening on http://localhost:${port}`);
    });
}

startServer().catch((error) => {
    console.error("Failed to start server", error);
    process.exit(1);
});
