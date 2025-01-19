import OpenAI from "openai";

const express = require("express");
const axios = require("axios");

const app = express();
const port = 3001;

// Google Search API configuration
const googleApiKey = process.env.GOOGLE_SEARCH_API_KEY;
const mapsApiKey = process.env.GOOGLE_API_KEY;
const googleSearchEngineId = "e0b3c25aac1c6497d";

// TODO: verify the type of data that is generated by chat-gpt
const spec =
  'list of "landmarks" with "name" "state" "country" "address", list of "events" with "name" and "address" and "time"'
const systemPrompt =
  "Extract city names, location data, country names, any geographical location, landmarks, etc. from the following text:, and format it in json (only the json object!), accorinding to the following specification: " +
  spec;
const prompt_to_split_query_type =
  "Determine if 1. the user wants directions to a specific place, or 2. suggestions for activities or locations. Type only 1 or 2 as your answer.";
const prompt_to_get_address =
  "Extract the address, location, or physical location from the query string. Only the address should be returned. You have to return something, can't be empty. Respond only with the address.";
const route_categories = ["safety - the safest route, good ", "scenery"];
const checkpoint_prompt = "Give me physical locations The user wants to choose a route which matches the following criteria: ";

// HELPER FUNCTIONS

const getLatLon = async (data) => {
  Promise.all(data.predictions.map(async (prediction) => {
    const detailsResponse = await fetch(
      `https://maps.googleapis.com/maps/api/place/details/json?place_id=${prediction.place_id}&key=${mapsApiKey}`
    );
    if (!detailsResponse.ok) {
      throw new Error(`Places Details API request failed with status ${detailsResponse.status}`);
    }
    const detailsData = await detailsResponse.json();
    const location = detailsData.result.geometry.location;
    return {
      description: prediction.description,
      placeId: prediction.place_id,
      lat: location.lat,
      lng: location.lng
    };
  }));
}

// Get places suggestions from Google Places Autocomplete API
async function getPlaceSuggestions(input) {
  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&key=${mapsApiKey}`
    );
    if (!response.ok) {
      throw new Error(`Places Autocomplete API request failed with status ${response.status}`);
    }
    const data = await response.json();
    console.log("Places Autocomplete API response data:", data);

    if (data.predictions.length === 0) {
      console.warn("No suggestions found for the given input:", input);
      return [];
    }

    // Get detailed information for each place
    const detailedResults = await Promise.all(data.predictions.map(async (prediction) => {
      const detailsResponse = await fetch(
        `https://maps.googleapis.com/maps/api/place/details/json?place_id=${prediction.place_id}&key=${mapsApiKey}`
      );
      if (!detailsResponse.ok) {
        throw new Error(`Places Details API request failed with status ${detailsResponse.status}`);
      }
      const detailsData = await detailsResponse.json();
      const location = detailsData.result.geometry.location;
      return {
        description: prediction.description,
        placeId: prediction.place_id,
        lat: location.lat,
        lng: location.lng
      };
    }));

    return detailedResults;
  } catch (error) {
    console.error("Error in getPlaceSuggestions:", error);
    return [];
  }
}

// Extract the address from the user's query
const getAddress = async (str) => {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_KEY,
    dangerouslyAllowBrowser: true,
  });

  const messages = [
    { role: "system", content: prompt_to_get_address },
    { role: "user", content: str },
  ];

  const completion = await openai.chat.completions.create({
    messages: messages,
    model: "gpt-4o-mini",
  });
  // console.log("CHAT GPT REPONSE: "+completion.choices[0].message.content);
  return completion.choices[0].message.content;
};

// Determine whether the user wants directions or suggestions
const determineIntent = async (query) => {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_KEY,
    dangerouslyAllowBrowser: true,
  });

  const messages = [
    { role: "system", content: prompt_to_split_query_type },
    { role: "user", content: query },
  ];

  const completion = await openai.chat.completions.create({
    messages: messages,
    model: "gpt-4o-mini",
  });
  // console.log("CHAT GPT REPONSE: "+completion.choices[0].message.content);
  return completion.choices[0].message.content;
};

const getCheckpoints = async () => {
  // get scenic and safety checkpoints
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_KEY,
    dangerouslyAllowBrowser: true,
  });

  const messages = [
    { role: "system", content: "The user wants to choose a route which matches the following criteria:" },
    { role: "user", content: "show scenic and safety checkpoints" },
  ];

  const completion = await openai.chat.completions.create({
    messages: messages,
    model: "gpt-4o-mini",
  });
  // console.log("CHAT GPT REPONSE: "+completion.choices[0].message.content);
  return completion.choices[0].message.content;
}

const parseWebResults = async (obj) => {
  // get coords from obj.events
  for (ev in obj.events) {
    const suggestions = await getPlaceSuggestions(ev.address);
    ev.lat = suggestions[0].lat;
    ev.lng = suggestions[0].lng;
  }
  return JSON.stringify(obj);
}

// return list of {desc place-id lat lng checkpoints}
// checkpoints {scenic: [[lat, ln], {lat ln}, ...], safety: []}


// search returns list of {desc place-id lat lng}
// Pass in http://localhost:3001/search?q=your_search_query
app.get("/search", async (req, res) => {
  const query = req.query.q;
  const lat = req.query.lat;
  const lng = req.query.lng;

  if (!query) {
    return res.status(400).send('Query parameter "q" is required');
  }

  const intent = await determineIntent(query);
  const nadd = await getAddress(query);
  const suggestions = await getPlaceSuggestions(nadd + " ");

  // Navigation
  if (intent === "1") {
      // return { places: [{desc place-id lat lng}], webresults: [] } 
    for (const suggestion of suggestions) {
      console.log("PLACE SUGGESTION: " + suggestion.description + suggestion.lat + suggestion.lng); 
    }

    const places = { places: suggestions, webresults: [] };
    console.log("ENDPOINT RESPONSE: "+JSON.stringify(places));
    return res.json(places);
  } 
  // List places, events, web/news articles, marketplace
  else {
    try {
      console.log("LIST PLACES: " + query);

      // Search Google
      const googleResponse = await fetch(
        `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleSearchEngineId}&q=${query}`
      );
      if (!googleResponse.ok) {
        throw new Error(
          `Google API request failed with status ${googleResponse.status}`
        );
      }
      const googleData = await googleResponse.json();
      console.log(googleData);
      // console.log(googleResponse);

      // // Extract search results
      const searchResults = googleData.items
        .map((item) => item.snippet)
        .join("\n");
      console.log("SEARCH RESULTS: " + searchResults);

      // Seaerch results
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_KEY,
        dangerouslyAllowBrowser: true,
      });

      // Parse search results for city names, etc.

      // Find city names, etc.
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: searchResults },
      ];

      const completion = await openai.chat.completions.create({
        messages: messages,
        model: "gpt-4o-mini",
      });

      const res_string = completion.choices[0].message.content;
      const jsonStringMatch = res_string.match(/{[\s\S]*}/);
      const new_res_string = jsonStringMatch[0];

      // console.log("CHAT GPT STRING",res_string);
      console.log("REGEX CHAT GPT STRING",new_res_string);

      console.log("LN LAT ADDED CHAT GPT STRING",new_res_string);
      const res_json = JSON.parse(new_res_string);
      const new_res_json = await parseWebResults(res_json);
      
      // "list of 'cities' with 'name' 'state' 'country', list of 'landmarks' (string), list of 'events' with 'name' and 'date' and 'time'
      console.log("CHAT GPT JSON: " + JSON.stringify(new_res_json));

      
      // Format of endpoint response
      const places = { places: suggestions, webresults: new_res_json };

      console.log("ENDPOINT RESPONSE: " + JSON.stringify(places));
      return res.json(places);
    } catch (error) {
      console.error(error);
      res.status(500).send("An error occurred");
    }
  }
});

app.get("/checkpoints", async (req, res) => {  
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
