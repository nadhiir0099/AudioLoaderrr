//required packages
const express = require("express");
const fetch = require("node-fetch");
require("dotenv").config();

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

app.post("/convert-mp3", async (req,res) => {
    const inputLink = req.body.videoID;
    let initial = 0;
    let final = 0;
    let videoId ="";
    if(inputLink.indexOf("&")!=-1){
        initial += inputLink.indexOf("=") + 1;
        final += inputLink.indexOf("&");
        videoId += inputLink.slice(initial, final);
    }else{
        videoId +=inputLink.substring(17, inputLink.lengh) 
    }

    console.log(`id: ${videoId}`)
    if(!videoId){
        return res.render("index", {success : false, message : "Please insert a video ID"});
    }else{
        const fetchAPI = await fetch(`https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`, {
            "method" : "GET",
            "headers" : {
                "x-rapidapi-key" : process.env.API_KEY,
                "x-rapidapi-host" : process.env.API_HOST
            }
        });
        const fetchResponse = await fetchAPI.json();
        const Emsg = "AudioLoad is still in beta and it has a limited number of donwloads... \nPlease wait and come back later."
        if(fetchResponse.status === "ok")
            return res.render("index",{success : true, song_title : fetchResponse.title, song_link : fetchResponse.link});
        else
            return res.render("index", {success : false, message : fetchResponse.msg || Emsg})
    }
})

// start the server
app.listen(PORT, ()=>{
    console.log(`server started on port ${PORT}`);
});

