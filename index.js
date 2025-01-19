import OpenAI from "openai";

const express = require("express");
const axios = require("axios");


const app = express();
const port = 3001;

// Google Search API configuration
const googleApiKey = process.env.GOOGLE_SEARCH_API_KEY;
const mapsApiKey = process.env.GOOGLE_API_KEY;
const googleSearchEngineId = "e0b3c25aac1c6497d";

const cors = require("cors");

const corsOptions = {
  origin: "http://localhost:3000", // Allow requests from this origin
  methods: ["GET", "POST", "PUT", "DELETE"], // Specify allowed methods
};


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

const checkpoint_prompt = `You are a route planner AI specialized in generating physical checkpoints (addresses of real-world locations) along a route. Your goal is to provide a series of logical checkpoints that reflect the user's priority: either 'scenery' or 'safety.'

  Given a start address and an end address, you will:
  1. Understand the user's preference ('scenery' or 'safety').
  2. Generate a detailed route that includes real physical addresses of recognizable locations (e.g., parks, cafes, rest stops, or landmarks) as checkpoints. Each checkpoint must be evenly spaced and relevant to the selected priority.
  3. Return the route in JSON format as follows:
  {
    "start": "Start Address",
    "scenic": ["address1", "address2", ...],
    "safety": ["address1", "address2", ...],
    "end": "End Address"
  }
  Ensure all addresses are full physical addresses, including the street name, city, and postal/ZIP code where possible.
  Keep all responses concise and focus on accurate, relevant information. If a specific location cannot be identified, select a nearby notable address that matches the route preference. Never leave a route incomplete. Only answer in JSON.`;


// HELPER FUNCTIONS

// Parse GPT JSON response
const parseGPTResponseToJSON = (str) => {
  const jsonStringMatch = str.match(/{[\s\S]*}/);
  const new_res_string = jsonStringMatch[0];
  return JSON.parse(new_res_string);
};

// Function to get address from latitude and longitude using Google Maps Geocoding API
async function getAddressFromLatLng(lat, lng) {
  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${mapsApiKey}`
    );
    if (!response.ok) {
      throw new Error(`Geocoding API request failed with status ${response.status}`);
    }
    const data = await response.json();
    if (data.results.length === 0) {
      console.warn("No address found for the given coordinates:", lat, lng);
      return null;
    }
    return data.results[0].formatted_address;
  } catch (error) {
    console.error("Error in getAddressFromLatLng:", error);
    return null;
  }
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

// Function to get latitude and longitude from an address string using Google Maps Geocoding API
async function getLatLngFromString(address) {
  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${mapsApiKey}`
    );
    if (!response.ok) {
      throw new Error(`Geocoding API request failed with status ${response.status}`);
    }
    const data = await response.json();
    if (data.results.length === 0) {
      console.warn("No results found for the given address:", address);
      return null;
    }
    const location = data.results[0].geometry.location;
    return { lat: location.lat, lng: location.lng };
  } catch (error) {
    console.error("Error in getLatLngFromString:", error);
    return null;
  }
}

// checkpoints {scenic: [[lat, ln], [lat ln], ...], safety: []}
const getCheckpoints = async (lat, lng, route_type) => {
  // get scenic and safety checkpoints
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_KEY,
    dangerouslyAllowBrowser: true,
  });

  const address = await getAddressFromLatLng(lat, lng);

  const messages = [
    { role: "system", content: checkpoint_prompt },
    { role: "user", content: `User wants ${route_type} route. User starts from ${address}` }
  ];

  const completion = await openai.chat.completions.create({
    messages: messages,
    model: "gpt-4o-mini",
  });

  const result = completion.choices[0].message.content;
  // const jsonStringMatch = result.match(/{[\s\S]*}/);
  // const new_res_string = jsonStringMatch[0];
  const result_json = parseGPTResponseToJSON(result);
  console.log(result);
  console.log(result_json);

  const scenic = await Promise.all(result_json.scenic.map(async (a) => {
    const location = await getLatLngFromString(a);
    return [location.lat, location.lng];
  }));

  const safety = await Promise.all(result_json.safety.map(async (a) => {
    const location = await getLatLngFromString(a);
    return [location.lat, location.lng];
  }));

  console.log("CHAT GPT REPONSE: "+completion.choices[0].message.content);
  return { scenic: scenic, safety: safety };
}

const parseWebResults = async (obj) => {
  // get coords from obj.events
  // for (ev in obj.events) {
    // const suggestions = await getPlaceSuggestions(ev.address);
  //   ev.lat = suggestions[0].lat;
  //   ev.lng = suggestions[0].lng;
  // }

  for(let i =0; i < obj.events.length; i++) {
    const eve = obj.events[i];
    const suggestions = await getPlaceSuggestions(eve.address);
    console.log(eve.name, eve.address, eve.time);
    eve.lat = suggestions[0].lat;
    eve.lng = suggestions[0].lng;
    console.log(eve.lat, eve.lng);
  }
  console.log("EVENTS: ", obj.events);
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
      console.log("GOOGLE DATA", googleData);
      // console.log(googleResponse);

      // // Extract search results
      let searchResults;
      if (!googleData || !googleData.items) {
        searchResults = {}
      }
      searchResults = googleData.items
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
      const new_res_string = parseGPTResponseToJSON(res_string);

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

const route_categories = ["safety - the safest route, good ", "scenery"];


// checkpoints {scenic: [[lat, ln], [lat ln], ...], safety: []}
app.get("/checkpoints", async (req, res) => { 
  const lat = req.query.lat;
  const lng = req.query.lng;
  const route_type = req.query.type;

  const checkpoints = await getCheckpoints(lat, lng, route_type);
  return res.json(checkpoints);
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
