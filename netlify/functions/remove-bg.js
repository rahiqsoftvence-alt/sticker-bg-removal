const https = require("https");

// ── Safe base64 encoder ──
const toBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return Buffer.from(buffer).toString("base64");
};

// ── Parse multipart form data manually ──
const parseMultipart = (body, boundary) => {
  const parts = body.split(`--${boundary}`);
  for (const part of parts) {
    if (part.includes('name="image"')) {
      const split = part.indexOf("\r\n\r\n");
      if (split === -1) continue;
      const data = part.slice(split + 4, part.lastIndexOf("\r\n"));
      return Buffer.from(data, "binary");
    }
  }
  return null;
};

exports.handler = async (event) => {
  const allowedOrigin = "https://peakpurposewrld.com";

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: "Method not allowed",
    };
  }

  try {
    const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
    const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

    if (!IMGBB_API_KEY) throw new Error("IMGBB_API_KEY not set");
    if (!RAPIDAPI_KEY) throw new Error("RAPIDAPI_KEY not set");

    // ── Parse the uploaded image from multipart body ──
    const contentType = event.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) throw new Error("No boundary found in content-type");

    const boundary = boundaryMatch[1];
    const bodyBuffer = Buffer.from(
      event.body,
      event.isBase64Encoded ? "base64" : "binary",
    );
    const imageBuffer = parseMultipart(bodyBuffer.toString("binary"), boundary);

    if (!imageBuffer) throw new Error("Could not parse image from request");

    // ── Step 1: Upload to ImgBB ──
    const base64Image = imageBuffer.toString("base64");

    const imgbbParams = new URLSearchParams();
    imgbbParams.append("key", IMGBB_API_KEY);
    imgbbParams.append("image", base64Image);
    const imgbbBody = imgbbParams.toString();

    const imgbbResponse = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "api.imgbb.com",
          path: "/1/upload",
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(imgbbBody),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        },
      );
      req.on("error", reject);
      req.write(imgbbBody);
      req.end();
    });

    if (imgbbResponse.status !== 200) {
      throw new Error(
        `ImgBB failed (${imgbbResponse.status}): ${imgbbResponse.body}`,
      );
    }

    const imgbbJson = JSON.parse(imgbbResponse.body);
    if (!imgbbJson.success)
      throw new Error("ImgBB error: " + JSON.stringify(imgbbJson));

    const publicUrl = imgbbJson.data.url;
    console.log("✅ ImgBB URL:", publicUrl);

    // ── Step 2: RapidAPI background removal ──
    const rapidBodyStr = `image_url=${encodeURIComponent(publicUrl)}&bg_image_url=`;

    const rapidResponse = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "background-removal-ai.p.rapidapi.com",
          path: "/image-background",
          method: "POST",
          headers: {
            "x-rapidapi-key": RAPIDAPI_KEY,
            "x-rapidapi-host": "background-removal-ai.p.rapidapi.com",
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(rapidBodyStr),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              contentType: res.headers["content-type"] || "",
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on("error", reject);
      req.write(rapidBodyStr);
      req.end();
    });

    console.log("RapidAPI status:", rapidResponse.status);
    console.log("RapidAPI content-type:", rapidResponse.contentType);

    if (rapidResponse.status !== 200) {
      throw new Error(
        `RapidAPI failed (${rapidResponse.status}): ${rapidResponse.body.toString()}`,
      );
    }

    if (rapidResponse.contentType.includes("application/json")) {
      throw new Error(
        "RapidAPI returned error: " + rapidResponse.body.toString(),
      );
    }

    // ── Step 3: Return base64 image to browser ──
    const resultBase64 = rapidResponse.body.toString("base64");

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        image: resultBase64,
        contentType: rapidResponse.contentType,
      }),
    };
  } catch (err) {
    console.error("❌ Error:", err.message);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ success: false, error: err.message }),
    };
  }
};
