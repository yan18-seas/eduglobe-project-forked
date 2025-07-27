import { GoogleGenerativeAI } from "@google/genai";
import { SYSTEM_PROMPTS } from "../src/constants";
import { Language, Role, Message } from "../src/types";

// Gemini setup
const genAI = new GoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// Language mapping
const getLanguageCode = (lang: Language): string => {
  const codes: Record<string, string> = {
    [Language.ENGLISH]: "en",
    [Language.TIBETAN]: "bo",
    [Language.HAWAIIAN]: "haw",
    [Language.TELUGU]: "te",
  };
  return codes[lang] || "en";
};

// Translate text to target language using REST
const translateText = async (
  text: string,
  targetLang: Language
): Promise<string> => {
  const target = getLanguageCode(targetLang);
  if (target === "en") return text;

  const res = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, target, format: "text" }),
    }
  );

  const json = await res.json();
  return json?.data?.translations?.[0]?.translatedText || text;
};

// Generate short conversation title
const generateChatName = async (
  firstMessage: string,
  lang: Language
): Promise<string> => {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const prompt = `Summarize this user query into a short, 3-5 word chat title. Reply in "${lang}": "${firstMessage}"`;

    const result = await model.generateContent(prompt);
    const text = await result.text();
    return text.replace(/["'.]/g, "");
  } catch (err) {
    console.error("Error generating chat name:", err);
    return firstMessage.slice(0, 30) + "...";
  }
};

// Route handler
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
    });
  }

  if (!process.env.GEMINI_API_KEY) {
    return new Response(
      JSON.stringify({ error: "GEMINI_API_KEY is not configured" }),
      { status: 500 }
    );
  }

  try {
    const body = await req.json();
    const {
      messages,
      language,
      conversationName,
    }: {
      messages: Message[];
      language: Language;
      conversationName?: string;
    } = body;

    const userMessages = messages.filter((m) => m.role === Role.USER);
    const lastUserMessage = userMessages[userMessages.length - 1]?.text ?? "";

    const translatedMessages = await Promise.all(
      messages.map(async (msg) => ({
        role: msg.role === Role.USER ? "user" : "model",
        parts: [
          {
            text:
              msg.role === Role.USER
                ? await translateText(msg.text, Language.ENGLISH)
                : msg.text,
          },
        ],
      }))
    );

    const model = genAI.getGenerativeModel({
      model: "gemini-pro",
      generationConfig: { temperature: 0.7 },
      systemInstruction: {
        role: "system",
        parts: [{ text: SYSTEM_PROMPTS[language] }],
      },
    });

    const result = await model.generateContent({
      contents: translatedMessages,
    });

    const englishResponse = await result.text();
    const translatedResponse = await translateText(englishResponse, language);

    const aiMessage: Message = {
      id: Date.now().toString(),
      role: Role.AI,
      text: translatedResponse,
      language,
    };

    let title = conversationName;
    if (!conversationName && userMessages.length === 1) {
      title = await generateChatName(lastUserMessage, language);
    }

    return new Response(
      JSON.stringify({ message: aiMessage, conversationName: title }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("Internal error:", err);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
    });
  }
}
