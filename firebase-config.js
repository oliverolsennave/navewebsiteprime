// ==========================================================================
// Firebase Configuration
// ==========================================================================
// 
// INSTRUCTIONS:
// 1. Go to your Firebase Console: https://console.firebase.google.com/
// 2. Select your project (or create one)
// 3. Go to Project Settings > General > Your apps
// 4. If you haven't added a web app, click "Add app" and select Web
// 5. Copy your config values below
// 6. Make sure Firestore is enabled in your Firebase project
//
// ==========================================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { getAuth, GoogleAuthProvider, OAuthProvider } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

// Your Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyDMzrI35yZxIlUr-OJ56acE_bMnYnrHoEw",
    authDomain: "navefirebase.firebaseapp.com",
    projectId: "navefirebase",
    storageBucket: "navefirebase.firebasestorage.app",
    messagingSenderId: "701712826975",
    appId: "1:701712826975:web:placeholder"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firestore
const db = getFirestore(app);

// Initialize Auth
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
const appleProvider = new OAuthProvider('apple.com');

export { app, db, auth, googleProvider, appleProvider };

