const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const rateLimit = require('express-rate-limit');


const app = express();
const port = 3004;

const getClientIp = (req) => {
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    return xForwardedFor.split(',')[0].trim();
  }
  return req.ip;
};

const limiter = rateLimit({
  windowMs: 60 * 1000, 
  max: 5, 
  keyGenerator: getClientIp, 
  handler: (req, res,) => {
    const timeRemaining = Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000);
    const errorMessage = `Rate limit exceeded. Please try again in ${timeRemaining} seconds.`;
    const errorResponse = createSillyTavernError(errorMessage);
    
    console.log(`[${new Date().toISOString()}] Rate limit reached for IP: ${getClientIp(req)}`);
    
    res.status(429).json(errorResponse);
  },
  standardHeaders: true,
  legacyHeaders: false 
});

app.use(cors());

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function createSillyTavernError(message) {
  return {
    error: {
      message: message,
      type: "invalid_request_error",
      param: null,
      code: null
    }
  };
}

const grokConfig = {
  method: 'post',
  url: 'https://api.x.com/2/grok/add_response.json',
  headers: {
    'Authorization': `Bearer ${config.authToken}`,
    'Content-Type': 'text/plain;charset=UTF-8',
    'Cookie': config.cookie,
    'Origin': 'https://x.com',
    'Referer': 'https://x.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0',
    'x-csrf-token': config.csrfToken,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': 'en'
  }
};

function convertSillyTavernToPlaintext(messages) {
  let plaintext = "";
  let systemMessages = "";
  for (const message of messages) {
    if (message.role === "user") {
      plaintext += `Human: ${message.content}\n`;
    } else if (message.role === "assistant") {
      plaintext += `Assistant: ${message.content}\n`;
    } else if (message.role === "system") {
      systemMessages += `${message.content}\n`;
    }
  }
  return { plaintext, systemMessages };
}

async function getNewConversationId() {
  try {
    const response = await axios({
      method: 'post',
      url: 'https://x.com/i/api/graphql/UBIjqHqsA5aixuibXTBheQ/CreateGrokConversation',
      headers: {
        ...grokConfig.headers,
        'Content-Type': 'application/json',
      },
      data: {
        variables: {},
        queryId: "UBIjqHqsA5aixuibXTBheQ"
      }
    });

    return response.data.data.create_grok_conversation.conversation_id;
  } catch (error) {
    console.error('Error getting new conversation ID:', error);
    throw error;
  }
}

function countWords(text) {
  return text.split(/\s+/).filter(word => word.length > 0).length;
}

function removeTweetLinks(text) {
  // Regular expression to match tweet links with newlines and '=='
  const tweetLinkRegex = /(?:\n*)?\[link\]\(#tweet=\d+\)(?:\s*==\s*)?/g;
  
  const replaceFunc = (match, offset, string) => {
    if (offset === 0 || string[offset - 1] === '\n') {
      return '';
    }
    return ' ';
  };

  return text.replace(tweetLinkRegex, replaceFunc);
}
app.get('/models', (req, res) => {
  const models = [
    {
      id: "fun",
      name: "Grok Fun",
      description: "Grok model with a fun personality"
    },
    {
      id: "normal",
      name: "Grok Normal",
      description: "Standard Grok model"
    }
  ];
  
  res.json({ data: models });
});

app.post('/chat/completions', limiter, async (req, res) => {
  const startTime = new Date();
  const clientIp = getClientIp(req);
  console.log(`[${startTime.toISOString()}] Received new request from IP: ${clientIp}`);

  const { messages, model } = req.body;

  let systemPromptName = "normal";
  if (model === "fun") {
    systemPromptName = "fun";
  }

  console.log(`Selected model: ${model || 'default'}`);
  console.log(`Using system prompt: ${systemPromptName}`);

  try {
    const conversationId = await getNewConversationId();
    const { plaintext, systemMessages } = convertSillyTavernToPlaintext(messages);

    const fullContext = systemMessages + plaintext;

    const inputWordCount = countWords(fullContext);
    console.log(`Input word count: ${inputWordCount}`);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    const grokResponse = await axios({
      ...grokConfig,
      responseType: 'stream',
      data: JSON.stringify({
        responses: [{ message: fullContext, sender: 1 }],
        systemPromptName: systemPromptName,
        grokModelOptionId: "grok-2",
        conversationId: conversationId
      })
    });

    let outputWordCount = 0;
    let buffer = '';

    grokResponse.data.on('data', (chunk) => {
      buffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        
        if (line.trim()) {
          try {
            const parsedChunk = JSON.parse(line);
            if (parsedChunk.result && parsedChunk.result.message) {
              // Remove tweet links from the message
              const cleanedMessage = removeTweetLinks(parsedChunk.result.message);
              outputWordCount += countWords(cleanedMessage);
              const sseData = JSON.stringify({
                choices: [{ delta: { content: cleanedMessage } }]
              });
              res.write(`data: ${sseData}\n\n`);
            }
          } catch (error) {
            console.error('Error parsing JSON:', error);
          }
        }
      }
    });

    grokResponse.data.on('end', () => {
      res.write(`data: [DONE]\n\n`);
      res.end();

      const endTime = new Date();
      const duration = (endTime - startTime) / 1000; // Duration in seconds
      console.log(`[${endTime.toISOString()}] Request completed for IP: ${clientIp}`);
      console.log(`Duration: ${duration.toFixed(2)} seconds`);
      console.log(`Output word count: ${outputWordCount}`);
      console.log('---');
    });

  } catch (error) {
    console.error('Error:', error);
    const errorResponse = createSillyTavernError('An error occurred while processing your request.');
    res.status(500).json(errorResponse);

    const endTime = new Date();
    const duration = (endTime - startTime) / 1000; // Duration in seconds
    console.log(`[${endTime.toISOString()}] Request failed`);
    console.log(`Duration: ${duration.toFixed(2)} seconds`);
    console.log('---');
  }
});

app.listen(port, () => {
  console.log(`Grok-compatible API listening at http://localhost:${port}`);
});
