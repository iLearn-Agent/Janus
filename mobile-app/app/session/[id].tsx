import { useLocalSearchParams } from 'expo-router';
import { SafeAreaView, Text, View } from 'react-native';
import { ChatComposer } from '@/components/ChatComposer';
import { styles } from '@/theme';

export default function SessionScreen() { const { id } = useLocalSearchParams<{ id: string }>(); return <SafeAreaView style={styles.safe}><View style={styles.container}><Text style={styles.title}>uBuddy</Text><Text style={styles.muted}>会话：{id}</Text><View style={styles.message}><Text>你好，我是 uBuddy。这里是手机端 App 框架，后续会连接电脑端 Janus。</Text></View><ChatComposer /></View></SafeAreaView>; }
