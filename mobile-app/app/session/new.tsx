import { router } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { styles } from '@/theme';

export default function NewSession() { useEffect(() => { const timer = setTimeout(() => router.replace('/session/mock-ubuddy'), 250); return () => clearTimeout(timer); }, []); return <View style={styles.center}><ActivityIndicator /></View>; }
