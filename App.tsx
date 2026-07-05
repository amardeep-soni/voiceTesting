import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  TextInput,
  SafeAreaView,
  ScrollView,
  Animated,
  Easing,
  Platform,
  Alert,
  PermissionsAndroid,
  StatusBar as RNStatusBar
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import AudioRecorderPlayer from 'react-native-nitro-sound';
import ReactNativeBlobUtil from 'react-native-blob-util';

// Interface for chat history messages
interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

// App states
type AppState = 'idle' | 'recording' | 'transcribing' | 'thinking' | 'generating' | 'speaking' | 'error';

export default function App() {
  // App State variables
  const [apiKey, setApiKey] = useState<string>('');
  const [selectedVoice, setSelectedVoice] = useState<string>('alloy');
  const [selectedLanguage, setSelectedLanguage] = useState<string>('English');
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [appState, setAppState] = useState<AppState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [recordingDuration, setRecordingDuration] = useState<number>(0);

  // Refs
  const recordingTimerRef = useRef<any>(null);
  const scrollViewRef = useRef<ScrollView | null>(null);

  // Native Audio Player & Recorder Instance
  const audioRecorderPlayer = AudioRecorderPlayer;

  // Animations
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;

  // Load API Key, Voice and Language settings on startup
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const savedKey = await AsyncStorage.getItem('OPENAI_API_KEY');
        if (savedKey) setApiKey(savedKey);
        
        const savedVoice = await AsyncStorage.getItem('OPENAI_VOICE');
        if (savedVoice) setSelectedVoice(savedVoice);

        const savedLanguage = await AsyncStorage.getItem('OPENAI_LANGUAGE');
        if (savedLanguage) setSelectedLanguage(savedLanguage);
      } catch (err) {
        console.warn('Failed to load settings from storage:', err);
      }
    };
    loadSettings();

    // Cleanup audio on unmount
    return () => {
      audioRecorderPlayer.stopPlayer().catch(() => {});
      audioRecorderPlayer.removePlayBackListener();
      audioRecorderPlayer.stopRecorder().catch(() => {});
      audioRecorderPlayer.removeRecordBackListener();
    };
  }, []);

  // Save OpenAI API Key
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testResultMsg, setTestResultMsg] = useState<string>('');

  const saveApiKey = async (key: string) => {
    setApiKey(key);
    setTestStatus('idle');
    setTestResultMsg('');
    try {
      await AsyncStorage.setItem('OPENAI_API_KEY', key);
    } catch (err) {
      console.warn('Failed to save API key:', err);
    }
  };

  const testApiKey = async () => {
    if (!apiKey.trim()) {
      setTestStatus('error');
      setTestResultMsg('Please enter an API key first.');
      return;
    }
    setTestStatus('testing');
    setTestResultMsg('');
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });

      if (response.ok) {
        setTestStatus('success');
        setTestResultMsg('Success! Your API key is valid.');
      } else {
        const errorData = await response.json().catch(() => ({}));
        const errMsg = errorData.error?.message || `HTTP error ${response.status}`;
        setTestStatus('error');
        setTestResultMsg(`Failed: ${errMsg}`);
      }
    } catch (err: any) {
      setTestStatus('error');
      setTestResultMsg(`Network error: ${err.message || 'Check connection'}`);
    }
  };

  // Save Chosen Voice
  const saveVoice = async (voice: string) => {
    setSelectedVoice(voice);
    try {
      await AsyncStorage.setItem('OPENAI_VOICE', voice);
    } catch (err) {
      console.warn('Failed to save voice choice:', err);
    }
  };

  // Save Chosen Language
  const saveLanguage = async (lang: string) => {
    setSelectedLanguage(lang);
    try {
      await AsyncStorage.setItem('OPENAI_LANGUAGE', lang);
    } catch (err) {
      console.warn('Failed to save language choice:', err);
    }
  };

  // Clear Chat History
  const clearChatHistory = () => {
    Alert.alert(
      'Clear History',
      'Are you sure you want to clear the conversation history?',
      [
        { text: 'Cancel', style: 'cancel' },
        { 
          text: 'Clear', 
          style: 'destructive',
          onPress: () => setMessages([]) 
        }
      ]
    );
  };

  // Scroll to bottom of message logs when a new message is added
  useEffect(() => {
    if (scrollViewRef.current) {
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages]);

  // Sync animations with the AppState
  useEffect(() => {
    pulseAnim.setValue(1);
    rotateAnim.setValue(0);
    
    let pulse: Animated.CompositeAnimation | null = null;
    let rotate: Animated.CompositeAnimation | null = null;

    if (appState === 'recording' || appState === 'speaking') {
      // Breathing pulse animation
      pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.18,
            duration: appState === 'recording' ? 700 : 1000,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1.0,
            duration: appState === 'recording' ? 700 : 1000,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
    } else if (appState === 'transcribing' || appState === 'thinking' || appState === 'generating') {
      // Rotation animation for load states
      rotate = Animated.loop(
        Animated.timing(rotateAnim, {
          toValue: 1,
          duration: 1500,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      );
      rotate.start();
    }

    return () => {
      if (pulse) pulse.stop();
      if (rotate) rotate.stop();
    };
  }, [appState]);

  // Start Audio Recording session
  const startRecording = async () => {
    // 1. Interrupt bot if it is speaking
    await stopAllSound();

    // 2. Request mic permissions on Android
    if (Platform.OS === 'android') {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Microphone Permission',
            message: 'This app needs access to your microphone so you can speak to the AI assistant.',
            buttonPositive: 'OK',
          }
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          Alert.alert(
            'Microphone Permission Required',
            'Cannot record audio without microphone permissions.'
          );
          return;
        }
      } catch (err) {
        console.error('Error requesting Android permissions:', err);
        return;
      }
    }

    // 3. Reset error and set state
    setErrorMessage(null);
    setAppState('recording');
    setRecordingDuration(0);

    // 4. Start recording timer
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = setInterval(() => {
      setRecordingDuration(prev => prev + 1);
    }, 1000);

    // 5. Start physical recording
    try {
      const uri = await audioRecorderPlayer.startRecorder();
      audioRecorderPlayer.addRecordBackListener((e: any) => {
        // Tracker callback (can be used for visualizers)
      });
      console.log('Recording started, temporary file path:', uri);
    } catch (err) {
      console.error('Failed to start recording session:', err);
      setAppState('error');
      setErrorMessage('Failed to start recording. Please try again.');
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    }
  };

  // Stop Audio Recording and start AI process flow
  const stopRecording = async () => {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }

    setAppState('transcribing');
    try {
      const uri = await audioRecorderPlayer.stopRecorder();
      audioRecorderPlayer.removeRecordBackListener();
      
      if (!uri) {
        throw new Error('Recording ended, but no audio file path was returned.');
      }
      
      // Send audio to AI processing pipeline
      await processVoiceInput(uri);
    } catch (err: any) {
      console.error('Failed to stop recording or process audio:', err);
      setAppState('error');
      setErrorMessage(err.message || 'Error saving recorded audio.');
    }
  };

  // Central voice pipeline: STT -> LLM -> TTS -> Audio Playback
  const processVoiceInput = async (recordingUri: string) => {
    if (!apiKey.trim()) {
      setAppState('error');
      setErrorMessage('OpenAI API Key is missing. Tap Settings (top-right) and enter your key.');
      return;
    }

    try {
      // --- PHASE 1: WHISPER STT ---
      const filename = recordingUri.split('/').pop() || 'recording.mp4';
      const cleanUri = recordingUri.startsWith('file://') ? recordingUri : `file://${recordingUri}`;
      const absolutePath = cleanUri.replace('file://', '');
      const match = /\.(\w+)$/.exec(filename);
      const fileType = match ? `audio/${match[1]}` : 'audio/mp4';

      let whisperPrompt = '';
      if (selectedLanguage === 'Bhojpuri') {
        whisperPrompt = 'यह बातचीत भोजपुरी (Bhojpuri) भाषा में है। रउआ, का, बा, हई, अइनी, तनी, ठीक, लोग जैसे भोजपुरी शब्दों को देवनागरी में लिखें।';
      } else if (selectedLanguage === 'Maithili') {
        whisperPrompt = 'यह बातचीत मैथिली (Maithili) भाषा में है। अहां, की, छै, यौ, कतय, कहब, मैथिली जैसे शब्दों को देवनागरी में लिखें।';
      } else if (selectedLanguage === 'Hindi') {
        whisperPrompt = 'यह बातचीत हिंदी (Hindi) भाषा में है। शुद्ध देवनागरी लिपि का प्रयोग करें।';
      }

      const sttResponse = await ReactNativeBlobUtil.fetch(
        'POST',
        'https://api.openai.com/v1/audio/transcriptions',
        {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'multipart/form-data',
        },
        [
          { name: 'file', filename: filename, type: fileType, data: ReactNativeBlobUtil.wrap(absolutePath) },
          { name: 'model', data: 'whisper-1' },
          { name: 'language', data: selectedLanguage === 'English' ? 'en' : 'hi' },
          { name: 'prompt', data: whisperPrompt }
        ]
      );

      const sttStatus = sttResponse.info().status;
      const sttText = await sttResponse.text();

      if (sttStatus < 200 || sttStatus >= 300) {
        throw new Error(`Speech-to-Text error (${sttStatus}): ${sttText}`);
      }

      const sttData = JSON.parse(sttText);
      const userText = sttData.text;

      if (!userText || !userText.trim()) {
        throw new Error('No clear speech was recognized. Please try speaking again.');
      }

      // Add user message to history
      const userMsg: Message = { id: Date.now().toString(), role: 'user', text: userText.trim() };
      setMessages(prev => [...prev, userMsg]);

      // --- PHASE 2: CHAT GPT (LLM) ---
      setAppState('thinking');

      // Take last few messages for context (context window optimization)
      const messageHistory = [...messages, userMsg].slice(-6).map(msg => ({
        role: msg.role,
        content: msg.text,
      }));

      let languageInstructions = '';
      if (selectedLanguage === 'Hindi') {
        languageInstructions = 'You MUST respond ONLY in Hindi (हिंदी) using Devanagari script. Speak in a warm, polite, and natural Hindi tone.';
      } else if (selectedLanguage === 'Bhojpuri') {
        languageInstructions = 'You MUST respond ONLY in Bhojpuri (भोजपुरी) using Devanagari script. Speak in a friendly, conversational, and natural Bhojpuri tone.';
      } else if (selectedLanguage === 'Maithili') {
        languageInstructions = 'You MUST respond ONLY in Maithili (मैथिली) using Devanagari script. Speak in a sweet, polite, and natural Maithili tone.';
      } else {
        languageInstructions = 'You MUST respond ONLY in English. Speak in a friendly, natural English tone.';
      }

      const systemPrompt = `You are Echo, a conversational, intelligent, and warm voice assistant. ${languageInstructions} Keep your responses short (1 to 3 sentences maximum) and easy to read aloud, as they will be spoken by text-to-speech. Never use markdown formatting (like asterisks, bolding, bullet points, or list numbers). Speak naturally.`;

      const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            ...messageHistory,
          ],
        }),
      });

      if (!gptResponse.ok) {
        const errorText = await gptResponse.text();
        throw new Error(`ChatGPT error (${gptResponse.status}): ${errorText}`);
      }

      const gptData = await gptResponse.json();
      const assistantText = gptData.choices[0].message.content;

      // Add assistant response to history
      const assistantMsg: Message = { id: (Date.now() + 1).toString(), role: 'assistant', text: assistantText.trim() };
      setMessages(prev => [...prev, assistantMsg]);

      // --- PHASE 3: OPENAI TTS ---
      setAppState('generating');

      const ttsResponse = await ReactNativeBlobUtil.fetch(
        'POST',
        'https://api.openai.com/v1/audio/speech',
        {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        JSON.stringify({
          model: 'tts-1',
          input: assistantText,
          voice: selectedVoice,
          speed: 0.94,
        })
      );

      const ttsStatus = ttsResponse.info().status;

      if (ttsStatus < 200 || ttsStatus >= 300) {
        const errorText = await ttsResponse.text();
        throw new Error(`Speech Generation error (${ttsStatus}): ${errorText}`);
      }

      const base64Audio = await ttsResponse.base64();
      const { dirs } = ReactNativeBlobUtil.fs;
      const fileUri = `${dirs.CacheDir}/msg_${assistantMsg.id}.mp3`;
      await ReactNativeBlobUtil.fs.writeFile(fileUri, base64Audio, 'base64');

      // --- PHASE 4: AUDIOPLAYER PLAYBACK ---
      setAppState('speaking');

      // Stop previous playback if active
      await stopAllSound();

      // Start Player
      const playUri = Platform.OS === 'android' ? `file://${fileUri}` : fileUri;
      await audioRecorderPlayer.startPlayer(playUri);

      // Listen for playback completion
      audioRecorderPlayer.addPlayBackListener((e: any) => {
        if (e.current_position >= e.duration && e.duration > 0) {
          // Playback completed, reset state to idle
          audioRecorderPlayer.stopPlayer().catch(() => {});
          audioRecorderPlayer.removePlayBackListener();
          setAppState('idle');
        }
      });

    } catch (err: any) {
      console.error('Error during AI process loop:', err);
      setAppState('error');
      setErrorMessage(err.message || 'An unexpected error occurred during processing.');
    }
  };

  // Stops any playing sound and resets the state to idle
  const stopAllSound = async () => {
    try {
      await audioRecorderPlayer.stopPlayer();
      audioRecorderPlayer.removePlayBackListener();
    } catch (e) {
      // Ignore
    }
    setAppState('idle');
  };

  // Replay speech for a specific message
  const replaySpeech = async (msgId: string, text: string) => {
    if (appState === 'recording' || appState === 'transcribing' || appState === 'thinking' || appState === 'generating') {
      return;
    }

    const { dirs } = ReactNativeBlobUtil.fs;
    const fileUri = `${dirs.CacheDir}/msg_${msgId}.mp3`;

    try {
      // Check if this message's audio is already cached locally
      const fileExists = await ReactNativeBlobUtil.fs.exists(fileUri);

      if (fileExists) {
        setAppState('speaking');
        await stopAllSound();
        const playUri = Platform.OS === 'android' ? `file://${fileUri}` : fileUri;
        await audioRecorderPlayer.startPlayer(playUri);

        audioRecorderPlayer.addPlayBackListener((e: any) => {
          if (e.current_position >= e.duration && e.duration > 0) {
            audioRecorderPlayer.stopPlayer().catch(() => {});
            audioRecorderPlayer.removePlayBackListener();
            setAppState('idle');
          }
        });
        return;
      }

      // If not cached, fetch from OpenAI TTS and write it to the unique message audio file path
      if (!apiKey.trim()) {
        Alert.alert('API Key Missing', 'Please enter your OpenAI API key in Settings.');
        return;
      }
      
      setAppState('generating');

      const ttsResponse = await ReactNativeBlobUtil.fetch(
        'POST',
        'https://api.openai.com/v1/audio/speech',
        {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        JSON.stringify({
          model: 'tts-1',
          input: text,
          voice: selectedVoice,
          speed: 0.94,
        })
      );

      const ttsStatus = ttsResponse.info().status;

      if (ttsStatus < 200 || ttsStatus >= 300) {
        const errorText = await ttsResponse.text();
        throw new Error(`Speech Replay error (${ttsStatus}): ${errorText}`);
      }

      const base64Audio = await ttsResponse.base64();
      await ReactNativeBlobUtil.fs.writeFile(fileUri, base64Audio, 'base64');

      setAppState('speaking');
      await stopAllSound();
      const playUri = Platform.OS === 'android' ? `file://${fileUri}` : fileUri;
      await audioRecorderPlayer.startPlayer(playUri);

      audioRecorderPlayer.addPlayBackListener((e: any) => {
        if (e.current_position >= e.duration && e.duration > 0) {
          audioRecorderPlayer.stopPlayer().catch(() => {});
          audioRecorderPlayer.removePlayBackListener();
          setAppState('idle');
        }
      });
    } catch (err: any) {
      console.error('Error replaying speech:', err);
      setAppState('error');
      setErrorMessage(err.message || 'Error replaying speech.');
    }
  };

  // Handles orb interactions based on active state (recording, speaking, idle)
  const handleOrbPress = () => {
    if (appState === 'recording') {
      stopRecording();
    } else if (appState === 'speaking' || appState === 'thinking' || appState === 'generating' || appState === 'transcribing') {
      stopAllSound();
    } else {
      startRecording();
    }
  };

  // Format recording timer duration into mm:ss
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // Rotate animation interpolation
  const rotateInterpolate = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  // Decide colors and labels based on appState
  const getOrbStyle = () => {
    switch (appState) {
      case 'recording':
        return {
          color: '#FF4D4D',
          label: 'Listening...',
          glowColor: 'rgba(255, 77, 77, 0.4)',
        };
      case 'transcribing':
        return {
          color: '#FFB800',
          label: 'Transcribing voice...',
          glowColor: 'rgba(255, 184, 0, 0.4)',
        };
      case 'thinking':
        return {
          color: '#00E5FF',
          label: 'Thinking...',
          glowColor: 'rgba(0, 229, 255, 0.4)',
        };
      case 'generating':
        return {
          color: '#7C4DFF',
          label: 'Generating speech...',
          glowColor: 'rgba(124, 77, 255, 0.4)',
        };
      case 'speaking':
        return {
          color: '#00E676',
          label: 'Speaking...',
          glowColor: 'rgba(0, 230, 118, 0.4)',
        };
      case 'error':
        return {
          color: '#FF3366',
          label: 'Error occurred',
          glowColor: 'rgba(255, 51, 102, 0.3)',
        };
      default:
        return {
          color: '#7C4DFF',
          label: 'Tap to talk',
          glowColor: 'rgba(124, 77, 255, 0.25)',
        };
    }
  };

  const orbTheme = getOrbStyle();

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      
      {/* HEADER SECTION */}
      <View style={styles.header}>
        <View style={styles.brandContainer}>
          <View style={styles.glowDot} />
          <Text style={styles.headerTitle}>EchoAgent AI</Text>
        </View>
        <TouchableOpacity 
          style={[styles.settingsButton, showSettings && styles.settingsButtonActive]} 
          onPress={() => setShowSettings(!showSettings)}
        >
          <Text style={styles.settingsButtonText}>{showSettings ? 'Close' : 'Settings'}</Text>
        </TouchableOpacity>
      </View>

      {/* SETTINGS CARD DROPDOWN */}
      {showSettings && (
        <View style={styles.settingsCard}>
          <Text style={styles.settingsLabel}>OpenAI API Key</Text>
          <TextInput
            style={styles.keyInput}
            value={apiKey}
            onChangeText={saveApiKey}
            placeholder="sk-proj-..."
            placeholderTextColor="#5E6782"
            secureTextEntry={true}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.testKeyContainer}>
            <TouchableOpacity
              style={[
                styles.testKeyButton,
                testStatus === 'testing' && styles.testKeyButtonDisabled
              ]}
              onPress={testApiKey}
              disabled={testStatus === 'testing'}
            >
              <Text style={styles.testKeyButtonText}>
                {testStatus === 'testing' ? 'Verifying...' : 'Test Connection'}
              </Text>
            </TouchableOpacity>
            {testStatus !== 'idle' && (
              <Text style={[
                styles.testResultText,
                testStatus === 'success' ? styles.testResultSuccess : styles.testResultError
              ]}>
                {testResultMsg}
              </Text>
            )}
          </View>
          <Text style={styles.settingsHint}>Keys are stored securely on your local device.</Text>

          <Text style={styles.settingsLabel}>Voice Tone</Text>
          <View style={styles.voiceRow}>
            {['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((voice) => (
              <TouchableOpacity
                key={voice}
                style={[
                  styles.voiceChip,
                  selectedVoice === voice && styles.voiceChipActive
                ]}
                onPress={() => saveVoice(voice)}
              >
                <Text style={[
                  styles.voiceChipText,
                  selectedVoice === voice && styles.voiceChipTextActive
                ]}>
                  {voice.charAt(0).toUpperCase() + voice.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.settingsLabel}>Response Language</Text>
          <View style={styles.voiceRow}>
            {['English', 'Hindi', 'Bhojpuri', 'Maithili'].map((lang) => (
              <TouchableOpacity
                key={lang}
                style={[
                  styles.voiceChip,
                  selectedLanguage === lang && styles.voiceChipActive
                ]}
                onPress={() => saveLanguage(lang)}
              >
                <Text style={[
                  styles.voiceChipText,
                  selectedLanguage === lang && styles.voiceChipTextActive
                ]}>
                  {lang}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity style={styles.clearButton} onPress={clearChatHistory}>
            <Text style={styles.clearButtonText}>Clear Chat Log</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* CONVERSATION FEED */}
      <ScrollView 
        ref={scrollViewRef}
        style={styles.feed}
        contentContainerStyle={styles.feedContent}
      >
        {messages.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyTitle}>Echo Mode</Text>
            <Text style={styles.emptySubtitle}>
              Experience an intelligent talking bot powered by ChatGPT, Whisper STT, and OpenAI TTS models.
            </Text>
            <View style={styles.instructionsBox}>
              <Text style={styles.instructionStep}>1. Tap Settings at the top-right.</Text>
              <Text style={styles.instructionStep}>2. Enter your OpenAI API Key.</Text>
              <Text style={styles.instructionStep}>3. Tap the glowing orb below and start talking!</Text>
            </View>
          </View>
        ) : (
          messages.map((msg) => (
            <View 
              key={msg.id} 
              style={[
                styles.messageRow, 
                msg.role === 'user' ? styles.messageUserRow : styles.messageAgentRow
              ]}
            >
              <View 
                style={[
                  styles.messageBubble,
                  msg.role === 'user' ? styles.messageUserBubble : styles.messageAgentBubble
                ]}
              >
                <View style={styles.messageHeaderRow}>
                  <Text style={styles.messageSender}>
                    {msg.role === 'user' ? 'You' : 'Echo'}
                  </Text>
                  {msg.role === 'assistant' && (
                    <TouchableOpacity 
                      onPress={() => replaySpeech(msg.id, msg.text)}
                      style={styles.replayButton}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.replayButtonText}>🔊 Listen</Text>
                    </TouchableOpacity>
                  )}
                </View>
                <Text style={styles.messageText}>{msg.text}</Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>

      {/* ERROR BANNER */}
      {appState === 'error' && errorMessage && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      )}

      {/* ORB VISUALIZER CONTAINER */}
      <View style={styles.orbWrapper}>
        <View style={styles.orbContainer}>
          
          {/* Animated Glowing Outer Ring */}
          {(appState === 'recording' || appState === 'speaking') ? (
            <Animated.View 
              style={[
                styles.orbPulseRing, 
                { 
                  borderColor: orbTheme.color,
                  backgroundColor: orbTheme.glowColor,
                  transform: [{ scale: pulseAnim }] 
                }
              ]} 
            />
          ) : null}

          {/* Animated Spinner Ring */}
          {(appState === 'transcribing' || appState === 'thinking' || appState === 'generating') ? (
            <Animated.View 
              style={[
                styles.orbSpinnerRing, 
                { 
                  borderColor: orbTheme.color,
                  borderTopColor: 'transparent',
                  transform: [{ rotate: rotateInterpolate }] 
                }
              ]} 
            />
          ) : null}

          {/* Interactive Core Button */}
          <TouchableOpacity 
            style={[
              styles.orbCore, 
              { 
                backgroundColor: orbTheme.color,
                shadowColor: orbTheme.color,
              }
            ]} 
            onPress={handleOrbPress}
            activeOpacity={0.85}
          >
            {appState === 'recording' ? (
              <View style={styles.stopIcon} />
            ) : appState === 'speaking' ? (
              <View style={styles.pauseIconContainer}>
                <View style={styles.pauseBar} />
                <View style={styles.pauseBar} />
              </View>
            ) : (
              <View style={styles.micIconContainer}>
                <View style={styles.micStem} />
                <View style={styles.micBase} />
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* STATE / TIMER LABEL */}
        <Text style={[styles.statusLabel, { color: appState === 'error' ? '#FF3366' : '#A9B6CE' }]}>
          {orbTheme.label}
        </Text>
        
        {appState === 'recording' && (
          <Text style={styles.timerLabel}>{formatTime(recordingDuration)}</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

// PREMIUM STYLES
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B0F19',
    paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight : 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.05)',
  },
  brandContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  glowDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#00E5FF',
    marginRight: 8,
    shadowColor: '#00E5FF',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  settingsButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  settingsButtonActive: {
    backgroundColor: '#7C4DFF',
    borderColor: '#7C4DFF',
  },
  settingsButtonText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
  },
  settingsCard: {
    backgroundColor: 'rgba(26, 32, 53, 0.95)',
    borderRadius: 16,
    marginHorizontal: 16,
    marginTop: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 8,
  },
  settingsLabel: {
    color: '#A9B6CE',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
  },
  keyInput: {
    backgroundColor: '#0F1322',
    color: '#FFFFFF',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontSize: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    marginBottom: 6,
  },
  settingsHint: {
    color: '#5E6782',
    fontSize: 11,
    marginBottom: 16,
  },
  voiceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
    marginBottom: 16,
  },
  voiceChip: {
    backgroundColor: '#0F1322',
    borderRadius: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginHorizontal: 4,
    marginVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  voiceChipActive: {
    backgroundColor: '#7C4DFF20',
    borderColor: '#7C4DFF',
  },
  voiceChipText: {
    color: '#A9B6CE',
    fontSize: 12,
    fontWeight: '500',
  },
  voiceChipTextActive: {
    color: '#7C4DFF',
    fontWeight: '700',
  },
  clearButton: {
    borderWidth: 1,
    borderColor: 'rgba(255, 77, 77, 0.4)',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  clearButtonText: {
    color: '#FF4D4D',
    fontSize: 13,
    fontWeight: '600',
  },
  feed: {
    flex: 1,
  },
  feedContent: {
    padding: 20,
    paddingBottom: 40,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 60,
  },
  emptyTitle: {
    fontSize: 32,
    fontWeight: '800',
    color: '#7C4DFF',
    marginBottom: 12,
    shadowColor: '#7C4DFF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
  },
  emptySubtitle: {
    fontSize: 15,
    color: '#A9B6CE',
    textAlign: 'center',
    lineHeight: 22,
    paddingHorizontal: 12,
    marginBottom: 32,
  },
  instructionsBox: {
    backgroundColor: '#111625',
    borderRadius: 12,
    padding: 16,
    width: '100%',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.04)',
  },
  instructionStep: {
    color: '#8A97AF',
    fontSize: 13,
    lineHeight: 20,
    marginVertical: 4,
  },
  messageRow: {
    flexDirection: 'row',
    marginVertical: 8,
    width: '100%',
  },
  messageUserRow: {
    justifyContent: 'flex-end',
  },
  messageAgentRow: {
    justifyContent: 'flex-start',
  },
  messageBubble: {
    maxWidth: '80%',
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  messageUserBubble: {
    backgroundColor: '#1E293B',
    borderTopRightRadius: 2,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  messageAgentBubble: {
    backgroundColor: '#1A182E',
    borderTopLeftRadius: 2,
    borderWidth: 1,
    borderColor: 'rgba(124, 77, 255, 0.15)',
  },
  messageSender: {
    fontSize: 11,
    fontWeight: '700',
    color: '#7C4DFF',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  messageText: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 20,
  },
  errorBanner: {
    backgroundColor: 'rgba(255, 51, 102, 0.15)',
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FF3366',
    marginBottom: 10,
  },
  errorText: {
    color: '#FF3366',
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
  },
  orbWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 10,
    paddingBottom: 40,
  },
  orbContainer: {
    width: 140,
    height: 140,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    marginBottom: 16,
  },
  orbPulseRing: {
    position: 'absolute',
    width: 130,
    height: 130,
    borderRadius: 65,
    borderWidth: 2,
  },
  orbSpinnerRing: {
    position: 'absolute',
    width: 130,
    height: 130,
    borderRadius: 65,
    borderWidth: 3,
  },
  orbCore: {
    width: 90,
    height: 90,
    borderRadius: 45,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 15,
    elevation: 10,
  },
  statusLabel: {
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  timerLabel: {
    fontSize: 14,
    color: '#FF4D4D',
    fontWeight: '700',
    marginTop: 4,
  },
  stopIcon: {
    width: 24,
    height: 24,
    backgroundColor: '#FFFFFF',
    borderRadius: 4,
  },
  pauseIconContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: 20,
    height: 24,
  },
  pauseBar: {
    width: 7,
    height: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 2,
  },
  micIconContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
  },
  micStem: {
    width: 10,
    height: 18,
    borderRadius: 5,
    backgroundColor: '#FFFFFF',
    marginBottom: 2,
  },
  micBase: {
    width: 16,
    height: 2,
    backgroundColor: '#FFFFFF',
  },
  testKeyContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  testKeyButton: {
    backgroundColor: '#7C4DFF',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginRight: 10,
  },
  testKeyButtonDisabled: {
    backgroundColor: '#3b2575',
  },
  testKeyButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  testResultText: {
    fontSize: 12,
    flex: 1,
    flexWrap: 'wrap',
  },
  testResultSuccess: {
    color: '#10B981',
  },
  testResultError: {
    color: '#EF4444',
  },
  messageHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    marginBottom: 4,
  },
  replayButton: {
    backgroundColor: '#7C4DFF20',
    borderColor: 'rgba(124, 77, 255, 0.4)',
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  replayButtonText: {
    color: '#7C4DFF',
    fontSize: 10,
    fontWeight: '700',
  },
});
