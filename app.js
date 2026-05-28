// npm run dev "this will start the server"

//required packages
const express = require("express");
const fetch = require("node-fetch");
require("dotenv").config();
const ytpl = require("ytpl");
const archiver = require("archiver");
const yts = require("yt-search");
const { getDetails } = require("spotify-url-info")(fetch);
const fs = require("fs");
const path = require("path");

const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

//create the express server
const app = express();

//server port number
const PORT =5000;

//insert template engine
app.set("view engine", "ejs");
app.use(express.static("public"));

//needed to parse html data for POST request
app.use(express.urlencoded({
    extended: true
}))
app.use(express.json());

app.get("/",(req,res) =>{
    res.render("index.ejs");
})

function extractVideoId(url) {
    if (!url) return null;
    url = url.trim();
    if (url.length === 11 && /^[a-zA-Z0-9_-]{11}$/.test(url)) {
        return url;
    }
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

// Rate Limiter to space out requests to RapidAPI (max 1 request every 1.5 seconds)
class RateLimiter {
    constructor(delayMs) {
        this.delayMs = delayMs;
        this.lastRequestTime = 0;
    }

    async wait() {
        const now = Date.now();
        const baseTime = Math.max(now, this.lastRequestTime);
        this.lastRequestTime = baseTime + this.delayMs;
        
        const actualWait = baseTime - now;
        if (actualWait > 0) {
            await new Promise(resolve => setTimeout(resolve, actualWait));
        }
    }
}

const limiter = new RateLimiter(1500);

async function fetchWithRateLimit(url, options) {
    await limiter.wait();
    return fetch(url, options);
}

// Parse API keys from .env
const apiKeys = process.env.API_KEYS
    ? process.env.API_KEYS.split(",").map(k => k.trim())
    : [process.env.API_KEY];
let currentKeyIndex = 0;

function rotateApiKey() {
    if (apiKeys.length <= 1) return;
    const oldKey = apiKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
    console.log(`[API Key Rotator] Key ${oldKey.substring(0, 8)}... rate-limited. Rotating to key ${apiKeys[currentKeyIndex].substring(0, 8)}...`);
}

// Poll the RapidAPI endpoint until status is 'ok' or max retries are reached
async function pollRapidAPI(videoId) {
    const maxRetries = 15;
    const delayMs = 3000; // Delay between polls for a specific track
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const currentKey = apiKeys[currentKeyIndex];
            const apiRes = await fetchWithRateLimit(`https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`, {
                method: "GET",
                headers: {
                    "x-rapidapi-key": currentKey,
                    "x-rapidapi-host": process.env.API_HOST
                }
            });

            if (apiRes.status === 429) {
                console.error(`[Poll API] Received 429 (Too Many Requests) for video ${videoId} with key index ${currentKeyIndex}.`);
                rotateApiKey();
                // retry immediately with new key without sleeping
                continue;
            }

            if (!apiRes.ok) {
                console.error(`[Poll API] Status error for video ${videoId}: ${apiRes.status}`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                continue;
            }

            const data = await apiRes.json();

            if (data.status === "ok" && data.link) {
                return data;
            } else if (data.status === "processing" || data.status === "waiting") {
                console.log(`[Poll API] Video ${videoId} is ${data.status} (attempt ${attempt}/${maxRetries})...`);
            } else if (data.status === "fail") {
                console.error(`[Poll API] Failed status for videoId ${videoId}:`, data.msg);
                return null;
            }
        } catch (err) {
            console.error(`[Poll API] Error for videoId ${videoId}:`, err);
        }

        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    return null;
}

app.post("/convert-mp3", async (req,res) => {
    const inputLink = req.body.videoID;
    const videoId = extractVideoId(inputLink);

    console.log(`id: ${videoId}`);
    if(!videoId){
        return res.status(400).json({success : false, message : "Please insert a valid YouTube video Link or ID"});
    }else{
        try {
            const apiData = await pollRapidAPI(videoId);
            const Emsg = "AudioLoad is still in beta and it has a limited number of downloads... \nPlease wait and come back later.";
            
            if(apiData && apiData.status === "ok" && apiData.link) {
                return res.json({success : true, song_title : apiData.title, song_link : apiData.link});
            } else {
                return res.json({success : false, message : (apiData && apiData.msg) || Emsg});
            }
        } catch (error) {
            console.error("Fetch API error:", error);
            return res.status(500).json({success : false, message : "API connection failed. Please ensure the server has a valid API key configuration."});
        }
    }
});

// Helper to sanitize filename
function sanitizeFilename(filename) {
    return filename.replace(/[^a-zA-Z0-9\-\_\.\s]/g, "").trim();
}

// Helper to download a file from a URL and pipe to a local path
async function downloadFile(url, destPath) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch file from CDN: ${res.statusText}`);
    const fileStream = fs.createWriteStream(destPath);
    return new Promise((resolve, reject) => {
        res.body.pipe(fileStream);
        res.body.on("error", reject);
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
    });
}

// POST route to convert a playlist
app.post("/convert-playlist", async (req, res) => {
    const playlistUrl = req.body.playlistUrl;
    if (!playlistUrl) {
        return res.status(400).json({ success: false, message: "Please insert a valid playlist link" });
    }

    try {
        const isValid = ytpl.validateID(playlistUrl);
        if (!isValid) {
            return res.status(400).json({ success: false, message: "Invalid YouTube Playlist URL or ID" });
        }

        const playlist = await ytpl(playlistUrl, { limit: 15 });
        const tracks = playlist.items;
        
        if (!tracks || tracks.length === 0) {
            return res.status(400).json({ success: false, message: "No tracks found in the playlist" });
        }

        const convertedTracks = new Array(tracks.length);

        const downloadPromises = tracks.map(async (track, index) => {
            const videoId = track.id;
            const title = track.title;
            const thumbnail = track.bestThumbnail ? track.bestThumbnail.url : track.thumbnails[0].url;
            const duration = track.duration;

            try {
                const apiData = await pollRapidAPI(videoId);

                if (apiData && apiData.status === "ok" && apiData.link) {
                    convertedTracks[index] = {
                        id: videoId,
                        title: title || apiData.title,
                        thumbnail: thumbnail,
                        duration: duration,
                        downloadUrl: apiData.link
                    };
                } else {
                    console.error(`Failed to convert track: ${title}`);
                }
            } catch (err) {
                console.error(`Error processing track ${title} (${videoId}):`, err);
            }
        });

        await Promise.all(downloadPromises);

        const finalTracks = convertedTracks.filter(t => t !== undefined);

        if (finalTracks.length === 0) {
            return res.status(500).json({ success: false, message: "Failed to convert any videos from this playlist." });
        }

        return res.json({
            success: true,
            playlistTitle: playlist.title,
            sessionId: "direct_links",
            tracks: finalTracks
        });

    } catch (error) {
        console.error("Playlist conversion error:", error);
        return res.status(500).json({ success: false, message: "An error occurred while parsing the playlist. Please try again." });
    }
});

// POST route to parse a Spotify playlist
app.post("/parse-spotify", async (req, res) => {
    const spotifyUrl = req.body.spotifyUrl;
    if (!spotifyUrl) {
        return res.status(400).json({ success: false, message: "Please insert a valid Spotify playlist link" });
    }

    try {
        if (!spotifyUrl.includes("spotify.com") && !spotifyUrl.includes("spotify.link")) {
            return res.status(400).json({ success: false, message: "Invalid Spotify playlist URL" });
        }

        const details = await getDetails(spotifyUrl);
        
        if (!details || !details.tracks || details.tracks.length === 0) {
            return res.status(400).json({ success: false, message: "No tracks found in this Spotify playlist" });
        }

        const playlistTitle = details.preview && details.preview.title ? details.preview.title : "Spotify Playlist";

        const mappedTracks = details.tracks.map((track) => {
            const title = track.name || track.title || "Unknown Track";

            let artistName = "Unknown Artist";
            if (track.artists && Array.isArray(track.artists) && track.artists.length > 0) {
                artistName = track.artists.map(a => a.name || a).join(", ");
            } else if (track.artist) {
                artistName = track.artist;
            } else if (track.artists) {
                artistName = track.artists;
            }

            let coverUrl = "";
            if (track.album && track.album.images && Array.isArray(track.album.images) && track.album.images.length > 0) {
                coverUrl = track.album.images[0].url || track.album.images[0];
            } else if (track.cover) {
                coverUrl = track.cover;
            } else if (track.image) {
                coverUrl = track.image;
            }

            const durationMs = track.duration_ms || track.duration || 0;
            let durationFormatted = "0:00";
            if (durationMs > 0) {
                const minutes = Math.floor(durationMs / 60000);
                const seconds = Math.floor((durationMs % 60000) / 1000);
                durationFormatted = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
            }

            return {
                title,
                artist: artistName,
                cover: coverUrl,
                duration: durationFormatted
            };
        });

        return res.json({
            success: true,
            playlistTitle: playlistTitle,
            tracks: mappedTracks
        });

    } catch (error) {
        console.error("Spotify parsing error:", error);
        return res.status(500).json({ success: false, message: "An error occurred while parsing the Spotify playlist. Please make sure the playlist is public." });
    }
});

// GET route to serve individual downloaded track with force-download headers
app.get("/downloads/:sessionId/:filename", (req, res) => {
    const sessionId = req.params.sessionId;
    const filename = req.params.filename;
    
    if (!/^[a-z0-9]+$/i.test(sessionId)) {
        return res.status(400).send("Invalid session ID");
    }

    const filePath = path.join(downloadsDir, sessionId, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File not found or session expired");
    }

    // res.download forces browser to download the file directly
    res.download(filePath, filename);
});

// ============================================
// Browse & Discover — Deezer + YouTube Routes
// ============================================

// GET /api/trending — Fetch Deezer global chart
app.get("/api/trending", async (req, res) => {
    try {
        const response = await fetch("https://api.deezer.com/chart/0/tracks?limit=40");
        if (!response.ok) throw new Error(`Deezer API error: ${response.status}`);
        const data = await response.json();

        const tracks = (data.data || []).map(track => ({
            id: track.id,
            title: track.title,
            artist: track.artist ? track.artist.name : "Unknown Artist",
            album: track.album ? track.album.title : "",
            cover: track.album ? track.album.cover_medium : "",
            preview: track.preview || ""
        }));

        return res.json({ success: true, tracks });
    } catch (err) {
        console.error("Deezer trending error:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch trending tracks." });
    }
});

// GET /api/search-tracks — Proxy search to Deezer
app.get("/api/search-tracks", async (req, res) => {
    const query = req.query.q;
    if (!query || query.trim().length === 0) {
        return res.status(400).json({ success: false, message: "Search query is required." });
    }

    try {
        const response = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=30`);
        if (!response.ok) throw new Error(`Deezer search error: ${response.status}`);
        const data = await response.json();

        const tracks = (data.data || []).map(track => ({
            id: track.id,
            title: track.title,
            artist: track.artist ? track.artist.name : "Unknown Artist",
            album: track.album ? track.album.title : "",
            cover: track.album ? track.album.cover_medium : "",
            preview: track.preview || ""
        }));

        return res.json({ success: true, tracks });
    } catch (err) {
        console.error("Deezer search error:", err);
        return res.status(500).json({ success: false, message: "Failed to search tracks." });
    }
});

// POST /download-curated — Search YouTube for track, convert via RapidAPI
app.post("/download-curated", async (req, res) => {
    const { title, artist } = req.body;
    if (!title || !artist) {
        return res.status(400).json({ success: false, message: "Both title and artist are required." });
    }

    try {
        // Step 1: Search YouTube for the track
        const searchQuery = `${title} ${artist} audio`;
        const ytResults = await yts(searchQuery);

        if (!ytResults || !ytResults.videos || ytResults.videos.length === 0) {
            return res.status(404).json({ success: false, message: "No YouTube result found for this track." });
        }

        // Pick the first (most relevant) video
        const video = ytResults.videos[0];
        const videoId = video.videoId;

        console.log(`[Browse Download] "${title}" by ${artist} → YouTube: ${videoId} (${video.title})`);

        // Step 2: Convert using existing RapidAPI pipeline
        const apiData = await pollRapidAPI(videoId);

        if (apiData && apiData.status === "ok" && apiData.link) {
            return res.json({
                success: true,
                song_title: apiData.title || `${title} - ${artist}`,
                song_link: apiData.link
            });
        } else {
            return res.json({
                success: false,
                message: (apiData && apiData.msg) || "Conversion failed. Please try again later."
            });
        }
    } catch (error) {
        console.error("[Browse Download] Error:", error);
        return res.status(500).json({ success: false, message: "Failed to find and convert this track." });
    }
});

// start the server
app.listen(PORT, ()=>{
    console.log(`server started on port ${PORT}`);
});

