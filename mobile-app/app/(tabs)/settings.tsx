import { Pressable, SafeAreaView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useConnectionStore } from '@/stores/connectionStore';
import { styles } from '@/theme';

export default function SettingsScreen() { const clear = useConnectionStore((state) => state.clear); return <SafeAreaView style={styles.safe}><View style={styles.container}><Text style={styles.title}>设置</Text><View style={styles.card}><Text style={styles.cardTitle}>电脑连接</Text><Text style={styles.muted}>局域网 · 当前已连接</Text></View><Pressable style={styles.secondaryButton} onPress={() => { clear(); router.replace('/connect'); }}><Text>断开并重新配对</Text></Pressable></View></SafeAreaView>; }
