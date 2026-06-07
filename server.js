require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { YoutubeTranscript } = require('youtube-transcript');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// HELPER: Extract YouTube Video ID
// ============================================
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// ============================================
// HELPER: Format transcript with timestamps
// ============================================
function formatTranscript(transcriptItems) {
  return transcriptItems.map(item => {
    const seconds = Math.floor(item.offset / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const timestamp = `${mins}:${String(secs).padStart(2, '0')}`;
    return `[${timestamp}] ${item.text}`;
  }).join('\n');
}

// ============================================
// HELPER: Get total duration from transcript
// ============================================
function getDuration(transcriptItems) {
  if (!transcriptItems.length) return '0:00';
  const lastItem = transcriptItems[transcriptItems.length - 1];
  const totalSeconds = Math.floor((lastItem.offset + lastItem.duration) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

// ============================================
// HELPER: Call OpenRouter API
// ============================================
async function callOpenRouter(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  
  const modelsToTry = [
    'openrouter/free',
    'deepseek/deepseek-chat-v3-0324',
    'google/gemma-3-27b-it:free',
    'meta-llama/llama-3.2-3b-instruct:free'
  ];

  let lastError = null;

  for (const model of modelsToTry) {
    try {
      console.log(`  Trying model: ${model}...`);
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'SumTube AI Summarizer'
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
          max_tokens: 8192,
          response_format: { type: 'json_object' }
        })
      });

      const data = await response.json();
      
      if (data.error) {
        console.warn(`  ⚠️ Model ${model} error: ${data.error.message?.slice(0, 100)}`);
        lastError = data.error;
        continue;
      }

      if (data.choices && data.choices[0]?.message?.content) {
        console.log(`  ✅ Success with model: ${model}`);
        return data.choices[0].message.content;
      }

      console.warn(`  ⚠️ Model ${model}: No content in response`);
      continue;
    } catch (err) {
      console.warn(`  ⚠️ Model ${model} failed: ${err.message?.slice(0, 100)}`);
      lastError = err;
      continue;
    }
  }

  throw new Error(lastError?.message || 'All models failed');
}

// ============================================
// API: Get video metadata via oEmbed
// ============================================
app.get('/api/video-info', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(oembedUrl);
    if (!response.ok) throw new Error('Video not found');
    const data = await response.json();

    res.json({ videoId, title: data.title, author: data.author_name, thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` });
  } catch (error) {
    console.error('Video info error:', error.message);
    res.status(500).json({ error: 'Could not fetch video info' });
  }
});

// ============================================
// API: Main Summarize Endpoint
// ============================================
app.post('/api/summarize', async (req, res) => {
  try {
    const { url, length = 'medium', language = 'en', mode = 'standard' } = req.body;

    if (!url) return res.status(400).json({ error: 'YouTube URL is required' });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL. Please paste a valid YouTube video link.' });

    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({ error: 'OpenRouter API key not configured. Please add your key to the .env file.' });
    }

    // Step 1: Fetch transcript
    console.log(`📝 Fetching transcript for video: ${videoId}`);
    let transcriptItems;
    try {
      transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
    } catch (transcriptError) {
      console.error('Transcript error:', transcriptError.message);
      return res.status(400).json({ error: 'Could not fetch transcript. This video may not have captions/subtitles enabled, or it may be private/restricted.' });
    }

    if (!transcriptItems || transcriptItems.length === 0) {
      return res.status(400).json({ error: 'No transcript available for this video.' });
    }

    const formattedTranscript = formatTranscript(transcriptItems);
    const duration = getDuration(transcriptItems);

    // Step 2: Get video title
    let videoTitle = 'YouTube Video';
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
      const metaResponse = await fetch(oembedUrl);
      if (metaResponse.ok) {
        const metaData = await metaResponse.json();
        videoTitle = metaData.title;
      }
    } catch (e) { console.warn('Could not fetch video title'); }

    // Step 3: Build AI prompt
    const wordCounts = { short: 150, medium: 350, long: 700 };
    const targetWords = wordCounts[length] || 350;
    const languageNames = { en: 'English', hi: 'Hindi', es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese', ar: 'Arabic', zh: 'Chinese', pt: 'Portuguese', ru: 'Russian' };
    const langName = languageNames[language] || 'English';

    const prompt = `You are an expert educational content analyst. Analyze this YouTube video transcript and generate a comprehensive summary pack.

VIDEO TITLE: "${videoTitle}"
VIDEO DURATION: ${duration}
TARGET LANGUAGE: ${langName}

TRANSCRIPT:
${formattedTranscript.slice(0, 25000)}

---

Generate ALL of the following in ${langName} language. Respond ONLY with valid JSON. Use this exact structure:

{
  "summary": "A detailed, readable summary of approximately ${targetWords} words. Write naturally as if explaining to a friend. Use clear paragraphs with specific details from the video.",
  "keyTimestamps": [
    {"time": "0:00", "text": "Description of what happens at this moment"}
  ],
  "keyConcepts": ["Concept 1", "Concept 2", "Concept 3", "Concept 4", "Concept 5", "Concept 6", "Concept 7", "Concept 8"],
  "quiz": [
    {
      "question": "A thoughtful question based on the video content?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": 0
    }
  ],
  "examNotes": {
    "definitions": [{"term": "Term", "definition": "Clear definition"}],
    "keyPoints": ["Important point 1", "Important point 2"],
    "formulas": ["Any formulas or frameworks mentioned"],
    "likelyQuestions": ["Potential exam question 1", "Potential exam question 2"]
  },
  "mindMap": {
    "center": "Main Topic (2-4 words)",
    "branches": [
      {"name": "Branch Name", "leaves": ["Leaf 1", "Leaf 2", "Leaf 3"]}
    ]
  }
}

RULES:
1. Generate 6-10 key timestamps spread across the video
2. Generate 8-12 key concepts
3. Generate 4-5 quiz questions with 4 options each
4. Generate 5-7 mind map branches with 2-4 leaves each
5. Make the summary natural and readable
6. All content must be in ${langName}
7. Return ONLY valid JSON`;

    // Step 4: Call AI
    console.log(`🤖 Calling AI for analysis...`);
    const aiText = await callOpenRouter(prompt);

    // Step 5: Parse response
    let aiData;
    try {
      let jsonStr = aiText;
      const jsonMatch = aiText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1];
      aiData = JSON.parse(jsonStr.trim());
    } catch (parseError) {
      console.error('JSON parse error:', parseError.message);
      console.error('Raw response:', aiText.slice(0, 500));
      return res.status(500).json({ error: 'AI generated an invalid response. Please try again.' });
    }

    // Step 6: Build response
    const responseData = {
      success: true, videoId, videoTitle, duration,
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      language: langName, summaryLength: length,
      summary: aiData.summary || 'Summary could not be generated.',
      keyTimestamps: aiData.keyTimestamps || [],
      keyConcepts: aiData.keyConcepts || [],
      quiz: (aiData.quiz || []).map(q => ({ question: q.question, options: q.options, correctAnswer: q.correctAnswer })),
      examNotes: aiData.examNotes || { definitions: [], keyPoints: [], formulas: [], likelyQuestions: [] },
      mindMap: aiData.mindMap || { center: videoTitle.slice(0, 20), branches: [] },
      generatedAt: new Date().toISOString()
    };

    console.log(`✅ Summary generated successfully for: ${videoTitle}`);
    res.json(responseData);

  } catch (error) {
    console.error('Summarize error:', error.message);
    res.status(500).json({ error: 'An error occurred while generating the summary. Please try again.' });
  }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║                                               ║
║   🎬 SumTube.ai — YouTube Summarizer          ║
║   🚀 Server running on http://localhost:${PORT}   ║
║                                               ║
║   📝 Paste a YouTube URL to get started!      ║
║                                               ║
╚═══════════════════════════════════════════════╝
  `);
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn('⚠️  WARNING: OpenRouter API key not set! Edit .env file and add your key.\n');
  }
});
