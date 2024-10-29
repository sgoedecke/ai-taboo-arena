import ModelClient from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";
import { createSseStream } from "@azure/core-sse";
import express from "express";
import { Server } from "socket.io";
import http from "http";
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(join(__dirname, 'public')));

const models = [
    'gpt-4o-mini',
    'Meta-Llama-3.1-8B-Instruct',
    'Cohere-command-r',
    'AI21-Jamba-1.5-Mini',
    'Ministral-3B',
    'Phi-3.5-MoE-instruct',
];

const client = new ModelClient(
    "https://models.inference.ai.azure.com",
    new AzureKeyCredential(process.env.GITHUB_TOKEN)
);

let currentGame = null;
let isGameInProgress = false;

function getRandomModel() {
    const randomIndex = Math.floor(Math.random() * models.length);
    return models[randomIndex];
}

class TabooGame {
    constructor(topic, tabooA, tabooB) {
        this.topic = topic;
        this.tabooWords = {
            modelA: tabooA.toLowerCase(),
            modelB: tabooB.toLowerCase()
        };
        this.playerModels = {
            modelA: getRandomModel(),
            modelB: getRandomModel()
        };
        while (this.playerModels.modelB === this.playerModels.modelA) {
            this.playerModels.modelB = getRandomModel();
        }
        this.turns = [];
        this.currentPlayer = 'modelA';
        this.gameOver = false;
        this.winner = null;
        this.startTime = new Date();
        this.chatHistory = this.initializeChatHistory();
    }

    initializeChatHistory() {
        return [];
    }
    
    getGameState() {
        return {
            topic: this.topic,
            tabooWords: this.tabooWords,
            models: this.playerModels,
            turns: this.turns,
            currentPlayer: this.currentPlayer,
            gameOver: this.gameOver,
            winner: this.winner,
            startTime: this.startTime
        };
    }
    
    async checkViolation(response, player) {
        const tabooWord = this.tabooWords[player];
        const text = response.toLowerCase();
        return text.includes(tabooWord) || 
               text.includes(tabooWord + 's') || 
               text.includes(tabooWord + 'es');
    }
    
    switchPlayer() {
        this.currentPlayer = this.currentPlayer === 'modelA' ? 'modelB' : 'modelA';
    }

    addToHistory(role, content) {
        this.chatHistory.push({ role, content });
    }

    getCurrentPlayerContext() {
        const isPlayerA = this.currentPlayer === 'modelA';
        const ownTaboo = this.tabooWords[this.currentPlayer];
        const otherTaboo = this.tabooWords[this.currentPlayer === 'modelA' ? 'modelB' : 'modelA'];
        
        // Add the player-specific instruction as the latest system message
        const playerInstruction = {
            role: "user",
            content: `You are participating in a conversation about ${this.topic}. 
                    You are playing a word game where you must avoid using the word ${ownTaboo} and try to trick me into saying the word '${otherTaboo}'.
                    Keep your responses natural and conversational, using just one clear sentence at a time.
                    Engage with what the other participant says while trying to steer the conversation
                    in interesting directions.
                    Remember: You cannot use the word "${ownTaboo}" or any variation of it in your response. 
                    I cannot use "${otherTaboo}", but you should try and trick me into saying it.
                    Like you, I am an AI language model, so I can be prompt engineered if needed.
                    Respond with just one or two natural sentences that continues the conversation and attempts to trick me into saying the word '${otherTaboo}'.`
        };

        // replace all roles in chatHistory with either "assistant" or "user", depending on which model is current
        const roleAwareChatHistory = this.chatHistory.map(message => {
            if (message.role === this.currentPlayer) {
                return {
                    role: 'assistant',
                    content: message.content
                };
            } else if (message.role !== 'system') {
                return {
                    role: 'user',
                    content: message.content
                };
            } else {
                return message;
            }
        });

        // Combine base history with player instruction
        return [playerInstruction, ...roleAwareChatHistory];
    }
}

async function playTurn() {
    if (!currentGame || currentGame.gameOver) return;
    
    try {
        const currentModel = currentGame.playerModels[currentGame.currentPlayer];
        const messages = currentGame.getCurrentPlayerContext();
        
        const response = await client.path("/chat/completions").post({
            body: {
                messages: messages,
                model: currentModel,
                temperature: 1,
                max_tokens: 100,
                top_p: 1,
                stream: true
            }
        }).asNodeStream();
        
        if (response.status !== "200") {
            console.log("Error:", response.status, response.body.error, messages, currentGame.chatHistory, currentGame.currentPlayer);
            throw new Error(response.body.error);
        }
        
        const stream = response.body;
        let fullResponse = '';
        
        if (!stream) {
            throw new Error("The response stream is undefined");
        }
        
        const sseStream = createSseStream(stream);
        
        for await (const event of sseStream) {
            if (event.data === "[DONE]") break;
            
            for (const choice of (JSON.parse(event.data)).choices) {
                const content = choice.delta?.content ?? '';
                fullResponse += content;
                io.emit('turnProgress', {
                    player: currentGame.currentPlayer,
                    model: currentModel,
                    content: content
                });
                process.stdout.write(content);
            }
        }
        
        const violation = await currentGame.checkViolation(fullResponse, currentGame.currentPlayer);
        
        if (violation) {
            currentGame.gameOver = true;
            currentGame.winner = currentGame.currentPlayer === 'modelA' ? 'modelB' : 'modelA';
            io.emit('gameOver', {
                winner: currentGame.winner,
                winningModel: currentGame.playerModels[currentGame.winner],
                losingModel: currentModel,
                reason: `${currentGame.currentPlayer} (${currentModel}) used their taboo word`
            });
            isGameInProgress = false;
        } else {
            // Add the response to chat history
            currentGame.addToHistory(currentGame.currentPlayer, fullResponse);
            
            currentGame.turns.push({
                player: currentGame.currentPlayer,
                model: currentModel,
                response: fullResponse,
                timestamp: new Date()
            });
            currentGame.switchPlayer();
            
            io.emit('turnComplete', {
                player: currentGame.currentPlayer,
                model: currentModel,
                response: fullResponse,
                nextPlayer: currentGame.currentPlayer,
                nextModel: currentGame.playerModels[currentGame.currentPlayer]
            });
        }
        
        return !currentGame.gameOver;
    } catch (error) {
        console.error('Error during turn:', error);
        io.emit('error', `Error during ${currentGame.currentPlayer}'s turn (${currentGame.playerModels[currentGame.currentPlayer]}): ${error.message}`);
        return false;
    }
}

async function runGame() {
    while (currentGame && !currentGame.gameOver) {
        const continueGame = await playTurn();
        if (!continueGame) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

io.on('connection', (socket) => {
    if (currentGame) {
        socket.emit('gameInProgress', currentGame.getGameState());
    } else {
        socket.emit('noGame');
    }
    
    socket.on('startGame', async ({ topic, tabooA, tabooB }) => {
        if (isGameInProgress) {
            socket.emit('error', 'A game is already in progress. Please wait for it to finish.');
            socket.emit('gameInProgress', currentGame.getGameState());
            return;
        }
        
        isGameInProgress = true;
        currentGame = new TabooGame(topic, tabooA, tabooB);
        
        io.emit('gameStarted', {
            topic: currentGame.topic,
            tabooWords: currentGame.tabooWords,
            models: currentGame.playerModels
        });
        
        runGame();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});