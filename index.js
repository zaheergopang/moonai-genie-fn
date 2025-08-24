// No external packages used.
const http = require("http");
const https = require("https");

// Get access token from metadata server (works inside Cloud Functions without internet to npm)
function getAccessToken() {
  return new Promise((resolve, reject) => {
    const options = {
      host: "metadata.google.internal",
      path: "/computeMetadata/v1/instance/service-accounts/default/token",
      headers: { "Metadata-Flavor": "Google" },
      timeout: 5000,
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (!json.access_token) return reject(new Error("No access_token"));
          resolve(json.access_token);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Metadata token timeout")));
    req.end();
  });
}

function vertexPredict({ token, project, location, model, prompt }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      instances: [{ content: prompt }],
      parameters: { temperature: 0.7, maxOutputTokens: 512 },
    });

    const options = {
      host: `${location}-aiplatform.googleapis.com`,
      path: `/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:predict`,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 10000,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Vertex AI HTTP ${res.statusCode}: ${data}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Vertex request timeout")));
    req.write(body);
    req.end();
  });
}

function sendCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

exports.generateIdeas = async (req, res) => {
  sendCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const topic = (req.body && req.body.topic ? String(req.body.topic) : "").trim();
    if (!topic) return res.status(400).json({ error: "Missing topic" });

    const project = process.env.PROJECT_ID;
    const location = process.env.LOCATION || "us-central1";
    const model = process.env.MODEL_NAME || "text-bison@001";

    const token = await getAccessToken();
    const prompt = `Give me 3 engaging YouTube content ideas about: "${topic}". 
Return each on a new line, no numbering, short but catchy.`;

    const json = await vertexPredict({ token, project, location, model, prompt });

    const raw =
      (json && json.predictions && json.predictions[0] && json.predictions[0].content) || "";
    const ideas = raw
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s);

    // Guarantee exactly 3 items
    const out = ideas.slice(0, 3);
    while (out.length < 3) out.push(`Idea ${out.length + 1}`);

    res.json({ ideas: out });
  } catch (err) {
    console.error("generateIdeas error:", err && err.stack ? err.stack : err);
    res.status(500).json({ error: "Internal error", detail: String(err && err.message || err) });
  }
};
