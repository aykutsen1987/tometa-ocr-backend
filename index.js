import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("✅ ToMeta OCR Server is running");
});

app.listen(PORT, () => {
  console.log("🚀 OCR server started on port", PORT);
});

