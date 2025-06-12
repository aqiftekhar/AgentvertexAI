const { VertexAI } = require('@google-cloud/vertexai');
const config = require('../config/settings');

const vertexAi = new VertexAI({ project: config.projectId, location: 'us-central1' });

const model = vertexAi.getGenerativeModel({ model: config.geminiModel });

async function generateGeminiResponse(prompt) {
  try {
    const response = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [{
                  text: `
                  You are a voice assistant. 
                  Only respond with spoken text. Do not generate or suggest images, videos, or visual content.
                  User said: "${prompt}"
                  `
                  }],
        },
      ],
    });

    const content = response?.response?.candidates?.[0]?.content?.parts?.[0]?.text;
    return content || 'No response';
  } catch (error) {
    console.error('Error generating content:', error);
    return 'Error occurred while generating content.';
  }
}

module.exports = { generateGeminiResponse };
