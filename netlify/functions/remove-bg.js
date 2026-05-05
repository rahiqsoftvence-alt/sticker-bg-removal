const https = require("https");

exports.handler = async (event) => {
  const allowedOrigin = "https://peakpurposewrld.com";

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method not allowed" };
  }

  try {
    const PHOTOROOM_API_KEY = process.env.PHOTOROOM_API_KEY;
    if (!PHOTOROOM_API_KEY) throw new Error("PHOTOROOM_API_KEY not set");

    // ── Parse multipart form data ──
    const contentType = event.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) throw new Error("No boundary found in content-type");

    const boundary = boundaryMatch[1];
    const bodyBuffer = Buffer.from(event.body, event.isBase64Encoded ? "base64" : "binary");

    // ── Extract image buffer and filename from multipart ──
    const bodyStr = bodyBuffer.toString("binary");
    const parts = bodyStr.split(`--${boundary}`);
    let imageBuffer = null;
    let imageType = "image/jpeg";
    let imageName = "image.jpg";

    for (const part of parts) {
      if (part.includes('name="image"')) {
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd === -1) continue;

        // Extract content-type from part headers
        const partHeaders = part.substring(0, headerEnd);
        const ctMatch = partHeaders.match(/Content-Type:\s*([^\r\n]+)/i);
        if (ctMatch) imageType = ctMatch[1].trim();
        const fnMatch = partHeaders.match(/filename="([^"]+)"/i);
        if (fnMatch) imageName = fnMatch[1];

        const data = part.slice(headerEnd + 4, part.lastIndexOf("\r\n"));
        imageBuffer = Buffer.from(data, "binary");
        break;
      }
    }

    if (!imageBuffer) throw new Error("Could not parse image from request");
    console.log("✅ Image parsed:", imageName, imageBuffer.length, "bytes");

    // ── Build multipart body for Photoroom API ──
    const photoroomBoundary = "----PhotoroomBoundary" + Date.now();

    const partHeader = [
      `--${photoroomBoundary}`,
      `Content-Disposition: form-data; name="image_file"; filename="${imageName}"`,
      `Content-Type: ${imageType}`,
      "",
      "",
    ].join("\r\n");

    const partFooter = `\r\n--${photoroomBoundary}--\r\n`;

    const bodyParts = [
      Buffer.from(partHeader, "utf8"),
      imageBuffer,
      Buffer.from(partFooter, "utf8"),
    ];
    const fullBody = Buffer.concat(bodyParts);

    console.log("⏳ Calling Photoroom API...");

    // ── Call Photoroom background removal API ──
    const photoroomResponse = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "sdk.photoroom.com",
          path: "/v1/segment",
          method: "POST",
          headers: {
            "x-api-key": PHOTOROOM_API_KEY,
            "Content-Type": `multipart/form-data; boundary=${photoroomBoundary}`,
            "Content-Length": fullBody.length,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              contentType: res.headers["content-type"] || "image/png",
              body: Buffer.concat(chunks),
            })
          );
        }
      );
      req.on("error", reject);
      req.write(fullBody);
      req.end();
    });

    console.log("Photoroom status:", photoroomResponse.status);
    console.log("Photoroom content-type:", photoroomResponse.contentType);

    if (photoroomResponse.status !== 200) {
      throw new Error(
        `Photoroom failed (${photoroomResponse.status}): ${photoroomResponse.body.toString()}`
      );
    }

    // ── Return transparent PNG as base64 ──
    const resultBase64 = photoroomResponse.body.toString("base64");
    console.log("✅ Background removed successfully");

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        image: resultBase64,
        contentType: photoroomResponse.contentType,
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
