const admin = require('firebase-admin');
const { formidable } = require('formidable');
const fs = require('fs');
const path = require('path');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    storageBucket: 'navefirebase.firebasestorage.app',
  });
}
const adminAuth = admin.auth();
const bucket = admin.storage().bucket();

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Verify Firebase auth
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) {
      return res.status(401).json({ error: 'Missing authorization token' });
    }

    let decodedToken;
    try {
      decodedToken = await adminAuth.verifyIdToken(idToken);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid authorization token' });
    }

    // Parse multipart form data
    const form = formidable({
      maxFileSize: 20 * 1024 * 1024, // 20MB
      filter: ({ mimetype }) => {
        return ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'].includes(mimetype);
      },
    });

    let fields, files;
    try {
      [fields, files] = await form.parse(req);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid file. Please upload a PDF, JPG, or PNG.' });
    }

    const fileArray = files.bulletin;
    if (!fileArray || fileArray.length === 0) {
      return res.status(400).json({ error: 'No bulletin file provided.' });
    }

    const file = fileArray[0];
    const fileBuffer = fs.readFileSync(file.filepath);
    const base64Data = fileBuffer.toString('base64');
    const mimeType = file.mimetype;
    const ext = path.extname(file.originalFilename || 'file.pdf').replace('.', '') || 'pdf';

    // Upload to Firebase Storage
    const sanitizedName = (decodedToken.email || decodedToken.uid)
      .replace(/[^a-zA-Z0-9]/g, '_');
    const storagePath = `bulletinimages/${sanitizedName}/${Date.now()}.${ext}`;
    let bulletinUrl = '';

    try {
      const storageFile = bucket.file(storagePath);
      await storageFile.save(fileBuffer, {
        metadata: {
          contentType: mimeType,
          metadata: { uploadedBy: decodedToken.uid },
        },
      });
      // Build Firebase Storage download URL (no makePublic needed)
      const encodedPath = encodeURIComponent(storagePath);
      bulletinUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media`;
    } catch (err) {
      console.error('Firebase Storage upload failed:', err);
      // Continue — we can still attempt extraction
    }

    // Send to OpenAI for extraction
    let extractedData = null;
    try {
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) throw new Error('OpenAI API key not configured');

      // PDFs use "file" content type; images use "image_url"
      const isPdf = mimeType === 'application/pdf';
      const fileContent = isPdf
        ? {
            type: 'file',
            file: {
              filename: file.originalFilename || 'bulletin.pdf',
              file_data: `data:${mimeType};base64,${base64Data}`,
            },
          }
        : {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64Data}`,
            },
          };

      const messages = [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Extract parish information from this church bulletin. Return ONLY valid JSON with no markdown formatting:\n{\n  "pastorName": "",\n  "email": "",\n  "phone": "",\n  "address": "",\n  "city": "",\n  "state": "",\n  "zipCode": "",\n  "website": "",\n  "description": "",\n  "massSchedule": {\n    "Sunday": [{ "time": "8:00 AM", "language": "English" }],\n    "Monday-Friday": [{ "time": "7:00 AM", "language": "English" }]\n  },\n  "confessionSchedule": {\n    "Saturday": [{ "time": "3:00 PM", "endTime": "4:30 PM", "language": "" }]\n  },\n  "adorationSchedule": {\n    "Monday-Friday": [{ "time": "6:00 PM", "endTime": "9:00 PM" }]\n  },\n  "upcomingEvents": [\n    { "title": "", "date": "Feb 18", "time": "6:30 PM", "location": "", "description": "" }\n  ],\n  "pastorPSAs": ""\n}\nValid day keys: "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Monday-Friday". Use 12-hour time format like "8:00 AM", "12:30 PM". For confession/adoration ranges use separate "time" (start) and "endTime" (end) fields. Use empty string for string fields not found. Return empty objects {} for schedules with no data. Return empty array [] for no events. For event dates use "MMM d" format (e.g. "Feb 18", "Mar 7"). For event times use 12-hour format (e.g. "6:30 PM"). Include event location/venue if mentioned.`,
            },
            fileContent,
          ],
        },
      ];

      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages,
          max_tokens: 2000,
          temperature: 0.1,
        }),
      });

      if (!openaiRes.ok) {
        const errBody = await openaiRes.text();
        throw new Error(`OpenAI API error: ${openaiRes.status} ${errBody}`);
      }

      const openaiData = await openaiRes.json();
      const content = openaiData.choices?.[0]?.message?.content || '';

      // Parse JSON from response (handle potential markdown code blocks)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        extractedData = JSON.parse(jsonMatch[0]);
      }
    } catch (err) {
      console.error('OpenAI extraction failed:', err);
      // extractedData stays null — client handles gracefully
    }

    // Clean up temp file
    try { fs.unlinkSync(file.filepath); } catch (_) {}

    return res.status(200).json({
      extractedData,
      bulletinUrl,
    });
  } catch (err) {
    console.error('process-bulletin error:', err);
    return res.status(500).json({ error: 'Failed to process bulletin.' });
  }
}

// Export handler first, then attach config so it isn't overwritten
module.exports = handler;
module.exports.config = {
  api: { bodyParser: false },
};
